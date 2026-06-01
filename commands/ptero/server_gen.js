const { ContainerBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const config = require("../../config.json");
const msgLog = require("../../utility/logger.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const { applicationApiCall, extractEnvVariables, getUserId, reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getEggData, getNodeIdByName, getNestIdByName, getEggIdByName, getAvailableUserMemory, getNodes, getNests, getEggs } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { COLORS, HTTP_STATUS_CODES, COLLECTOR_IDLE_TIMEOUT } = require("../../utility/constants.js");

async function getDefaultAllocation(node) {
  const apiResult = await applicationApiCall(`application/nodes/${node}/allocations`, "GET");
  const jsonString = await apiResult.body.json();
  const jsonData = await jsonString.data;

  for (let i = 0;i < jsonData.length;i++) {
    if (!jsonData[i].attributes.assigned && (jsonData[i].attributes.alias === null || (jsonData[i].attributes.alias !== null && jsonData[i].attributes.ip === "0.0.0.0"))) {
      return jsonData[i].attributes.id;
    }
  }
  return -1;
}

async function createServer(name, node, nest, egg, memory, discordId, userId) {
  if (name === "" || name === null) {
    return getErrorMessage("INVALID_INPUT");
  }
  const nodeId = await getNodeIdByName(node);
  if (nodeId === -1) {
    return getErrorMessage("NODE_NOT_FOUND");
  }
  else if (typeof(nodeId) === "string") {
    return nodeId;
  }

  let overheadMemory = config["default_overhead_mb"];
  const nestId = await getNestIdByName(nest);
  if (nestId === -1) {
    return getErrorMessage("NEST_NOT_FOUND");
  }
  if (nestId === config["minecraft_nest_id"]) {
    overheadMemory = config["java_overhead_mb"];
  }

  const eggId = await getEggIdByName(nestId, egg);
  if (eggId === -1) {
    return getErrorMessage("EGG_NOT_FOUND");
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

  const requestBody = JSON.stringify({
    "name": name,
    "user": userId,
    "egg": eggId,
    "docker_image": eggInfo.attributes.docker_image,
    "startup": eggInfo.attributes.startup,
    "environment": extractEnvVariables(eggInfo.attributes.relationships.variables),
    "limits": {
      "memory": memory,
      "overhead_memory": overheadMemory,
      "swap": -1,
      "disk": 0,
      "io": 500,
      "cpu": 800
    },
    "feature_limits": {
      "databases": 0,
      "backups": 24,
      "allocations": 4
    },
    "allocation": {
      "default": defaultAllocation
    }
  });

  const apiResult = await applicationApiCall("application/servers", "POST", requestBody);
  const jsonText = await apiResult.body.json();

  jsonText.statusCode = apiResult.statusCode;

  return jsonText;
}

module.exports = {
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

      const nodesData = await getNodes();
      const nestsData = await getNests();
      const availableMemory = await getAvailableUserMemory(panelId, discordId);

      if (!nodesData || !nodesData.data) {
        await interaction.reply({ content: getErrorMessage("CLIENT_API_FAILURE"), ephemeral: true });
        return;
      }

      if (!nestsData || !nestsData.data) {
        await interaction.reply({ content: getErrorMessage("CLIENT_API_FAILURE"), ephemeral: true });
        return;
      }

      if (nodesData.data.length === 0) {
        await interaction.reply({ content: getErrorMessage("NODE_NOT_FOUND"), ephemeral: true });
        return;
      }

      if (nestsData.data.length === 0) {
        await interaction.reply({ content: getErrorMessage("NEST_NOT_FOUND"), ephemeral: true });
        return;
      }

      // Build initial container with node selection
      const nodeSelectMenu = new StringSelectMenuBuilder()
        .setCustomId("node-selection")
        .setPlaceholder("Select a node");

      for (const node of nodesData.data) {
        nodeSelectMenu.addOptions(
          new StringSelectMenuOptionBuilder()
            .setLabel(node.attributes.name)
            .setDescription(`${node.attributes.description || "No description"}`)
            .setValue(String(node.attributes.id))
        );
      }

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

      await interaction.reply({
        components: [ initialContainer ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
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

      collector.on("collect", async i => {
        try {
          if (i.customId === "node-selection") {
            selectedNode = nodesData.data.find(n => String(n.attributes.id) === i.values[0]);

            // Build nest selection menu
            const nestSelectMenu = new StringSelectMenuBuilder()
              .setCustomId("nest-selection")
              .setPlaceholder("Select a nest (game type)");

            for (const nest of nestsData.data) {
              nestSelectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                  .setLabel(nest.attributes.name)
                  .setDescription(nest.attributes.description || "No description")
                  .setValue(String(nest.attributes.id))
              );
            }

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

            // Show modal for server name and memory
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

            await i.showModal(modal);

            // Wait for modal submission
            try {
              const modalSubmit = await i.awaitModalSubmit({
                filter: modalI => modalI.customId === "server-details-modal" && modalI.user.id === interaction.user.id,
                time: 300_000
              });

              serverName = modalSubmit.fields.getTextInputValue("server-name");
              const memoryInputValue = modalSubmit.fields.getTextInputValue("server-memory");
              serverMemory = parseInt(memoryInputValue, 10);

              if (isNaN(serverMemory) || serverMemory <= 0) {
                await modalSubmit.reply({ content: "Invalid memory value. Please enter a positive number.", ephemeral: true });
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
              selectedNode.attributes.name,
              selectedNest.attributes.name,
              selectedEgg.attributes.name,
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

            const nodeSelectMenu = new StringSelectMenuBuilder()
              .setCustomId("node-selection")
              .setPlaceholder("Select a node");

            for (const node of nodesData.data) {
              nodeSelectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                  .setLabel(node.attributes.name)
                  .setDescription(`${node.attributes.fqdn} | Memory: ${node.attributes.memory} MB`)
                  .setValue(String(node.attributes.id))
                  .setDefault(selectedNode && node.attributes.id === selectedNode.attributes.id)
              );
            }

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

            const nestSelectMenu = new StringSelectMenuBuilder()
              .setCustomId("nest-selection")
              .setPlaceholder("Select a nest (game type)");

            for (const nest of nestsData.data) {
              nestSelectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                  .setLabel(nest.attributes.name)
                  .setDescription(nest.attributes.description || "No description")
                  .setValue(String(nest.attributes.id))
                  .setDefault(selectedNest && nest.attributes.id === selectedNest.attributes.id)
              );
            }

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
            ephemeral: true
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
              text.setContent(getErrorMessage("USER_TIMEOUT"))
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
        ephemeral: true
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

