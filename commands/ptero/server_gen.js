const { ContainerBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const config = require("../../config.json");
const msgLog = require("../../utility/logger.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { applicationApiCall, resolveEnvVariables, getUserId, reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getEggData, getAvailableUserMemory, getNodes, getNests, getEggs } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { COLORS, HTTP_STATUS_CODES, COLLECTOR_IDLE_TIMEOUT } = require("../../utility/constants.js");

async function getDefaultAllocation(node) {
  const apiResult = await applicationApiCall(`application/nodes/${node}/allocations`, "GET");
  const jsonString = await apiResult.body.json();
  const jsonData = await jsonString.data;

  for (let i = 0;i < jsonData.length;i++) {
    if (!jsonData[i].attributes.assigned && (jsonData[i].attributes.alias === null || (jsonData[i].attributes.alias !== null && jsonData[i].attributes.ip === "0.0.0.0"))) {
      return jsonData[i].attributes;
    }
  }
  return -1;
}

async function createServer(name, nodeId, nestId, eggId, memory, discordId, userId) {
  if (name === "" || name === null) {
    return getErrorMessage("INVALID_INPUT");
  }

  let overheadMemory = config["default_overhead_mb"];
  if (nestId === config["minecraft_nest_id"]) {
    overheadMemory = config["java_overhead_mb"];
  }

  const availableMemory = await getAvailableUserMemory(userId, discordId);
  if (availableMemory !== -1 && availableMemory - memory < 0) {
    const memoryToFree = (availableMemory - memory) * -1;
    return getErrorMessage("SERVER_CREATION_FAILED_MEMORY", memoryToFree);
  }

  const defaultAllocation = await getDefaultAllocation(nodeId);
  if (defaultAllocation === -1) {
    return getErrorMessage("ALLOCATION_NOT_FOUND");
  }

  const eggInfo = await getEggData(nestId, eggId);
  if (eggInfo === -1) {
    return getErrorMessage("EGG_INFO_NOT_RETURNED");
  }

  const { environment, missing } = resolveEnvVariables(
    eggInfo.attributes.relationships.variables,
    { port: defaultAllocation.port }
  );
  if (missing.length > 0) {
    return getErrorMessage("MISSING_REQUIRED_VARIABLES", missing.map(m => m.name).join(", "));
  }

  const defaultLimits = config["default_server_limits"] ?? { swap: -1, disk: 0, io: 500, cpu: 800 };
  const defaultFeatureLimits = config["default_feature_limits"] ?? { databases: 0, backups: 24, allocations: 4 };

  const requestBody = JSON.stringify({
    "name": name,
    "user": userId,
    "egg": eggId,
    "docker_image": eggInfo.attributes.docker_image,
    "startup": eggInfo.attributes.startup,
    "environment": environment,
    "limits": {
      ...defaultLimits,
      "memory": memory,
      "overhead_memory": overheadMemory
    },
    "feature_limits": { ...defaultFeatureLimits },
    "allocation": {
      "default": defaultAllocation.id
    }
  });

  const apiResult = await applicationApiCall("application/servers", "POST", requestBody);
  const jsonText = await apiResult.body.json();

  jsonText.statusCode = apiResult.statusCode;

  return jsonText;
}

function buildNodeSelectMenu(nodesData, selectedNode = null) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("node-selection")
    .setPlaceholder("Select a node");

  for (const node of nodesData.data) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(node.attributes.name)
        .setDescription(`${node.attributes.fqdn} | Memory: ${node.attributes.memory} MB`)
        .setValue(String(node.attributes.id))
        .setDefault(!!selectedNode && node.attributes.id === selectedNode.attributes.id)
    );
  }

  return menu;
}

function buildNestSelectMenu(nestsData, selectedNest = null) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("nest-selection")
    .setPlaceholder("Select a nest (game type)");

  for (const nest of nestsData.data) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(nest.attributes.name)
        .setDescription(nest.attributes.description || "No description")
        .setValue(String(nest.attributes.id))
        .setDefault(!!selectedNest && nest.attributes.id === selectedNest.attributes.id)
    );
  }

  return menu;
}

function buildServerDetailsModal() {
  const modal = new ModalBuilder()
    .setCustomId("server-details-modal")
    .setTitle("Server Details");

  const nameInput = new TextInputBuilder()
    .setCustomId("server-name")
    .setLabel("Server Name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("My Server")
    .setRequired(true)
    .setMaxLength(40);

  const memoryInput = new TextInputBuilder()
    .setCustomId("server-memory")
    .setLabel("Memory (MB)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("1024")
    .setRequired(true)
    .setMaxLength(5);

  modal.addComponents(
    { type: 1, components: [ nameInput ] },
    { type: 1, components: [ memoryInput ] }
  );

  return modal;
}

module.exports = {
  category: "Servers",
  requiresApiKey: true,

  data: new SlashCommandBuilder()
    .setName("gen-server")
    .setDescription("Opens an interactive menu to create a new server"),

  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.CREATE_SERVER);
    if (authenticated === -1) {
      await interaction.reply({ content: getErrorMessage("USER_NOT_FOUND"), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!authenticated) {
      await interaction.reply({ content: getErrorMessage("INSUFFICIENT_PERMISSIONS"), flags: MessageFlags.Ephemeral });
      return;
    }

    if (!userHasClientApiKey(interaction.user.id)) {
      await interaction.reply({ content: getErrorMessage("API_KEY_NOT_SET"), flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const panelId = getUserId(interaction.user.id);
      const discordId = interaction.user.id;

      // Defer immediately: three panel calls can exceed the 3s interaction window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const [ nodesData, nestsData, availableMemory ] = await Promise.all([
        getNodes(),
        getNests(),
        getAvailableUserMemory(panelId, discordId)
      ]);

      if (!nodesData || !nodesData.data) {
        await interaction.editReply({ content: getErrorMessage("CLIENT_API_FAILURE") });
        return;
      }

      if (!nestsData || !nestsData.data) {
        await interaction.editReply({ content: getErrorMessage("CLIENT_API_FAILURE") });
        return;
      }

      if (nodesData.data.length === 0) {
        await interaction.editReply({ content: getErrorMessage("NODE_NOT_FOUND") });
        return;
      }

      if (nestsData.data.length === 0) {
        await interaction.editReply({ content: getErrorMessage("NEST_NOT_FOUND") });
        return;
      }

      // Build initial container with node selection
      const nodeSelectMenu = buildNodeSelectMenu(nodesData);

      const memoryDisplay = availableMemory === -1
        ? "Unlimited"
        : `${availableMemory} MB`;

      const initialContainer = new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addTextDisplayComponents(text =>
          text.setContent(`**Create New Server**\n\n**Available Memory:** ${memoryDisplay}\n\nSelect a node to host your server:`)
        )
        .addSeparatorComponents(separator => separator)
        .addActionRowComponents(actionRow =>
          actionRow.setComponents(nodeSelectMenu)
        );

      await interaction.editReply({
        components: [ initialContainer ],
        flags: MessageFlags.IsComponentsV2
      });

      const response = await interaction.fetchReply();
      const collector = response.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        idle: COLLECTOR_IDLE_TIMEOUT
      });

      let selectedNode = null;
      let selectedNest = null;
      let selectedEgg = null;
      let serverName = null;
      let serverMemory = null;

      const logGenAction = (i, action, extra = "") => {
        msgLog.log(`${i.user.username}/${i.user.id} | [gen-server] ${action}${extra ? ` | ${extra}` : ""}`);
      };

      // Shows the name/memory modal and, on submit, the confirmation screen.
      // Invalid input re-offers the modal via the "reenter-details" button
      // instead of stranding the flow on the egg-selection screen.
      const promptServerDetails = async i => {
        await i.showModal(buildServerDetailsModal());

        try {
          const modalSubmit = await i.awaitModalSubmit({
            filter: modalI => modalI.customId === "server-details-modal" && modalI.user.id === interaction.user.id,
            time: 300_000
          });

          serverName = modalSubmit.fields.getTextInputValue("server-name");
          const memoryInputValue = modalSubmit.fields.getTextInputValue("server-memory");
          serverMemory = parseInt(memoryInputValue, 10);

          if (isNaN(serverMemory) || serverMemory <= 0) {
            const invalidContainer = new ContainerBuilder()
              .setAccentColor(COLORS.DISABLED)
              .addTextDisplayComponents(text =>
                text.setContent(`**Create New Server**\n\n${getErrorMessage("INVALID_MEMORY_VALUE")}`)
              )
              .addSeparatorComponents(separator => separator)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(
                  new ButtonBuilder().setCustomId("reenter-details").setLabel("Re-enter Details").setStyle(ButtonStyle.Primary),
                  new ButtonBuilder().setCustomId("cancel-create").setLabel("Cancel").setStyle(ButtonStyle.Danger)
                )
              );

            await modalSubmit.update({
              components: [ invalidContainer ],
              flags: MessageFlags.IsComponentsV2
            });
            return;
          }

          // Check if user has enough memory
          const currentAvailableMemory = await getAvailableUserMemory(panelId, discordId);
          const memoryAfterCreation = currentAvailableMemory - serverMemory;

          const hasInsufficientMemory = currentAvailableMemory !== -1 && memoryAfterCreation < 0;

          let displayContent = "**Confirm Server Creation**\n\n" +
            `**Name:** ${serverName}\n` +
            `**Node:** ${selectedNode.attributes.name}\n` +
            `**Nest:** ${selectedNest.attributes.name}\n` +
            `**Egg:** ${selectedEgg.attributes.name}\n` +
            `**Memory:** ${serverMemory} MB\n\n`;

          if (hasInsufficientMemory) {
            const memoryToFree = Math.abs(memoryAfterCreation);
            displayContent += getErrorMessage("SERVER_CREATION_FAILED_MEMORY", memoryToFree);
          } else {
            const memoryDisplayAfter = currentAvailableMemory === -1
              ? "Unlimited"
              : `${memoryAfterCreation} MB`;
            displayContent += `**Remaining Memory:** ${memoryDisplayAfter}`;
          }

          // Show confirmation screen
          const confirmContainer = new ContainerBuilder()
            .setAccentColor(hasInsufficientMemory ? COLORS.DISABLED : COLORS.PRIMARY)
            .addTextDisplayComponents(text =>
              text.setContent(displayContent)
            )
            .addSeparatorComponents(separator => separator)
            .addActionRowComponents(actionRow =>
              actionRow.setComponents(
                new ButtonBuilder()
                  .setCustomId("confirm-create")
                  .setLabel("Create Server")
                  .setStyle(ButtonStyle.Success)
                  .setDisabled(hasInsufficientMemory),
                new ButtonBuilder()
                  .setCustomId("cancel-create")
                  .setLabel("Cancel")
                  .setStyle(ButtonStyle.Danger)
              )
            );

          await modalSubmit.update({
            components: [ confirmContainer ],
            flags: MessageFlags.IsComponentsV2
          });
        } catch (error) {
          msgLog.error(`Modal submit timeout or error: ${error.message}`);
        }
      };

      collector.on("collect", async i => {
        try {
          if (i.customId === "node-selection") {
            selectedNode = nodesData.data.find(n => String(n.attributes.id) === i.values[0]);

            const nestSelectMenu = buildNestSelectMenu(nestsData, selectedNest);

            const nestContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text =>
                text.setContent(`**Create New Server**\n\n**Selected Node:** ${selectedNode.attributes.name}\n\nSelect a nest (game type):`)
              )
              .addSeparatorComponents(separator => separator)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(nestSelectMenu)
              )
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(
                  new ButtonBuilder().setCustomId("back-to-nodes").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                )
              );

            await i.update({
              components: [ nestContainer ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "nest-selection") {
            selectedNest = nestsData.data.find(n => String(n.attributes.id) === i.values[0]);

            const eggsData = await getEggs(selectedNest.attributes.id);

            if (!eggsData || !eggsData.data) {
              await i.update({
                content: getErrorMessage("CLIENT_API_FAILURE"),
                components: []
              });
              collector.stop();
              return;
            }

            if (eggsData.data.length === 0) {
              await i.update({
                content: getErrorMessage("EGG_NOT_FOUND"),
                components: []
              });
              collector.stop();
              return;
            }

            const eggSelectMenu = new StringSelectMenuBuilder()
              .setCustomId("egg-selection")
              .setPlaceholder("Select an egg (server type)");

            for (const egg of eggsData.data) {
              eggSelectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                  .setLabel(egg.attributes.name)
                  .setDescription(egg.attributes.description?.substring(0, 100) || "No description")
                  .setValue(String(egg.attributes.id))
              );
            }

            const eggContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text =>
                text.setContent(`**Create New Server**\n\n**Node:** ${selectedNode.attributes.name}\n**Nest:** ${selectedNest.attributes.name}\n\nSelect an egg (server type):`)
              )
              .addSeparatorComponents(separator => separator)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(eggSelectMenu)
              )
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(
                  new ButtonBuilder().setCustomId("back-to-nests").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                )
              );

            await i.update({
              components: [ eggContainer ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "egg-selection") {
            const eggsData = await getEggs(selectedNest.attributes.id);
            selectedEgg = eggsData.data.find(e => String(e.attributes.id) === i.values[0]);

            await promptServerDetails(i);

          } else if (i.customId === "reenter-details") {
            await promptServerDetails(i);

          } else if (i.customId === "confirm-create") {
            await i.deferUpdate();

            const creatingContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text =>
                text.setContent("**Creating Server...**\n\nPlease wait, this may take a moment.")
              );

            await i.editReply({
              components: [ creatingContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            const apiResult = await createServer(
              serverName,
              selectedNode.attributes.id,
              selectedNest.attributes.id,
              selectedEgg.attributes.id,
              serverMemory,
              discordId,
              panelId
            );

            let resultContainer;
            if (apiResult.statusCode === HTTP_STATUS_CODES.CREATED) {
              logGenAction(i, "server-created", `name: ${apiResult.attributes.name} | id: ${apiResult.attributes.identifier} | memory: ${serverMemory} MB | node: ${selectedNode.attributes.name}`);
              resultContainer = new ContainerBuilder()
                .setAccentColor(COLORS.SUCCESS)
                .addTextDisplayComponents(text =>
                  text.setContent(
                    "**Server created successfully!**\n\n" +
                    `**Name:** ${apiResult.attributes.name}\n` +
                    "**Status:** Installing\n\n" +
                    `View your server at:\n${process.env.PANEL_URL.replace(/\/$/, "")}/server/${apiResult.attributes.identifier}`
                  )
                );
            } else if (typeof apiResult === "string") {
              msgLog.warn(`${i.user.username}/${i.user.id} | [gen-server] server-rejected | name: ${serverName} | memory: ${serverMemory} MB | reason: ${apiResult}`);
              resultContainer = new ContainerBuilder()
                .setAccentColor(COLORS.DISABLED)
                .addTextDisplayComponents(text =>
                  text.setContent(`**Server Creation Failed**\n\n${apiResult}`)
                );
            } else {
              msgLog.warn(`${i.user.username}/${i.user.id} | [gen-server] server-rejected | name: ${serverName} | memory: ${serverMemory} MB | reason: API status ${apiResult.statusCode}`);
              resultContainer = new ContainerBuilder()
                .setAccentColor(COLORS.DISABLED)
                .addTextDisplayComponents(text =>
                  text.setContent(`**Server Creation Failed**\n\n${getErrorMessage("API_REQUEST_FAILED", apiResult.statusCode)}`)
                );
            }

            await i.editReply({
              components: [ resultContainer ],
              flags: MessageFlags.IsComponentsV2
            });

            collector.stop("completed");

          } else if (i.customId === "cancel-create") {
            const cancelContainer = new ContainerBuilder()
              .setAccentColor(COLORS.DISABLED)
              .addTextDisplayComponents(text =>
                text.setContent("Server creation cancelled.")
              );

            await i.update({
              components: [ cancelContainer ],
              flags: MessageFlags.IsComponentsV2
            });
            collector.stop("cancelled");

          } else if (i.customId === "back-to-nodes") {
            selectedNest = null;
            selectedEgg = null;

            const nodeSelectMenu = buildNodeSelectMenu(nodesData, selectedNode);

            const currentAvailableMemory = await getAvailableUserMemory(panelId, discordId);
            const memoryDisplayBack = currentAvailableMemory === -1
              ? "Unlimited"
              : `${currentAvailableMemory} MB`;

            const backContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text =>
                text.setContent(`**Create New Server**\n\n**Available Memory:** ${memoryDisplayBack}\n\nSelect a node to host your server:`)
              )
              .addSeparatorComponents(separator => separator)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(nodeSelectMenu)
              );

            await i.update({
              components: [ backContainer ],
              flags: MessageFlags.IsComponentsV2
            });

          } else if (i.customId === "back-to-nests") {
            selectedEgg = null;

            const nestSelectMenu = buildNestSelectMenu(nestsData, selectedNest);

            const backContainer = new ContainerBuilder()
              .setAccentColor(COLORS.PRIMARY)
              .addTextDisplayComponents(text =>
                text.setContent(`**Create New Server**\n\n**Selected Node:** ${selectedNode.attributes.name}\n\nSelect a nest (game type):`)
              )
              .addSeparatorComponents(separator => separator)
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(nestSelectMenu)
              )
              .addActionRowComponents(actionRow =>
                actionRow.setComponents(
                  new ButtonBuilder().setCustomId("back-to-nodes").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                )
              );

            await i.update({
              components: [ backContainer ],
              flags: MessageFlags.IsComponentsV2
            });
          }

        } catch (error) {
          msgLog.error(`Error handling gen-server interaction: ${error.message}`);
          const errorResponse = {
            content: "An error occurred while processing your request.",
            flags: MessageFlags.Ephemeral
          };

          if (i.replied || i.deferred) {
            await i.followUp(errorResponse).catch(() => {});
          } else {
            await i.reply(errorResponse).catch(() => {});
          }
        }
      });

      collector.on("end", async (collected, reason) => {
        if (reason === "idle") {
          const timeoutContainer = new ContainerBuilder()
            .setAccentColor(COLORS.DISABLED)
            .addTextDisplayComponents(text =>
              text.setContent(getErrorMessage("USER_TIMEOUT", "/gen-server"))
            );

          await interaction.editReply({
            components: [ timeoutContainer ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => {});
        }
      });

    } catch (error) {
      msgLog.error(`Error in gen-server command: ${error.message}`);
      const errorMessage = {
        content: "An error occurred while loading the server creation menu.",
        flags: MessageFlags.Ephemeral
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => {});
      } else {
        await interaction.reply(errorMessage).catch(() => {});
      }
    }
  }
};

// Export helper for tests
module.exports.createServer = createServer;

