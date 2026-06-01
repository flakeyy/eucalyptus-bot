const { ContainerBuilder, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags } = require("discord.js");
const { PERMISSIONS, authenticateUserForPermission } = require("../../utility/permissions.js");
const msgLog = require("../../utility/logger.js");
const { reconstructCommand, userHasClientApiKey } = require("../../utility/helper_functions.js");
const { getNodes, getNests, getEggs } = require("../../utility/server_functions.js");
const { getErrorMessage } = require("../../utility/error_messages.js");
const { COLORS, COLLECTOR_IDLE_TIMEOUT } = require("../../utility/constants.js");

function buildCategorySelectMenu(selectedCategory = null, disabled = false) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("category-selection")
    .setPlaceholder(disabled ? "Session ended" : "Select a category")
    .setDisabled(disabled);

  const categories = [
    { label: "Nodes", value: "nodes", description: "View available nodes" },
    { label: "Nests & Eggs", value: "nests", description: "View available nests and eggs" }
  ];

  for (const category of categories) {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(category.label)
        .setDescription(category.description)
        .setValue(category.value)
        .setDefault(selectedCategory === category.value)
    );
  }

  return selectMenu;
}

function buildNestSelectMenu(nests, selectedNestId = null, disabled = false) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("nest-selection")
    .setPlaceholder(disabled ? "Session ended" : "Select a nest to view eggs")
    .setDisabled(disabled);

  if (nests && nests.data && nests.data.length > 0) {
    for (const nest of nests.data) {
      selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(nest.attributes.name)
          .setDescription(`ID: ${nest.attributes.id}`)
          .setValue(nest.attributes.id.toString())
          .setDefault(selectedNestId === nest.attributes.id.toString())
      );
    }
  } else {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("No nests available")
        .setValue("none")
    );
  }

  return selectMenu;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("service")
    .setDescription("View service information including nodes, nests, and eggs."),

  async execute(interaction) {
    msgLog.log(`${interaction.user.username}/${interaction.user.id} | ${reconstructCommand(interaction)}`);

    const authenticated = authenticateUserForPermission(interaction.user.id, PERMISSIONS.GET_SERVICE_INFORMATION);

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
      // Initial view with category selection
      const initialContainer = new ContainerBuilder()
        .setAccentColor(COLORS.PRIMARY)
        .addActionRowComponents(actionRow =>
          actionRow.setComponents(buildCategorySelectMenu())
        )
        .addTextDisplayComponents(text =>
          text.setContent("Select a category to view details.")
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

      let currentCategory = null;
      let nodesData = null;
      let nestsData = null;
      let eggsData = null;
      let selectedNestId = null;

      const createDisabledMenu = () => {
        const disabledContainer = new ContainerBuilder()
          .setAccentColor(COLORS.DISABLED)
          .addActionRowComponents(actionRow =>
            actionRow.setComponents(buildCategorySelectMenu(currentCategory, true))
          )
          .addTextDisplayComponents(text =>
            text.setContent(getErrorMessage("USER_TIMEOUT"))
          );

        return disabledContainer;
      };

      collector.on("collect", async i => {
        try {
          if (i.customId === "category-selection") {
            await i.deferUpdate();
            const category = i.values[0];
            currentCategory = category;

            if (category === "nodes") {
              if (!nodesData) {
                nodesData = await getNodes();
              }

              if (!nodesData || !nodesData.data) {
                const errorContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.DISABLED)
                  .addActionRowComponents(actionRow =>
                    actionRow.setComponents(buildCategorySelectMenu("nodes"))
                  )
                  .addTextDisplayComponents(text =>
                    text.setContent(getErrorMessage("CLIENT_API_FAILURE"))
                  );

                await i.editReply({
                  components: [ errorContainer ],
                  flags: MessageFlags.IsComponentsV2
                });
                return;
              }

              let nodesText = "";
              if (nodesData.data.length > 0) {
                for (const node of nodesData.data) {
                  nodesText += `**${node.attributes.name}**\n`;
                  nodesText += `${node.attributes.description || "No description"}\n`;
                }
              } else {
                nodesText += "No nodes available.";
              }

              const nodesContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(buildCategorySelectMenu("nodes"))
                )
                .addTextDisplayComponents(text =>
                  text.setContent(nodesText)
                );

              await i.editReply({
                components: [ nodesContainer ],
                flags: MessageFlags.IsComponentsV2
              });

            } else if (category === "nests") {
              if (!nestsData) {
                nestsData = await getNests();
              }

              if (!nestsData || !nestsData.data) {
                const errorContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.DISABLED)
                  .addActionRowComponents(actionRow =>
                    actionRow.setComponents(buildCategorySelectMenu("nests"))
                  )
                  .addTextDisplayComponents(text =>
                    text.setContent(getErrorMessage("CLIENT_API_FAILURE"))
                  );

                await i.editReply({
                  components: [ errorContainer ],
                  flags: MessageFlags.IsComponentsV2
                });
                return;
              }

              const nestsContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(buildCategorySelectMenu("nests"))
                );

              if (nestsData.data.length > 0) {
                nestsContainer
                  .addActionRowComponents(actionRow =>
                    actionRow.setComponents(buildNestSelectMenu(nestsData, selectedNestId))
                  );

                let nestsText = "";

                if (selectedNestId) {
                  // Show eggs for selected nest
                  const selectedNest = nestsData.data.find(n => n.attributes.id.toString() === selectedNestId);
                  if (selectedNest) {
                    nestsText += "**Available Eggs:**\n";

                    if (eggsData && eggsData.data && eggsData.data.length > 0) {
                      for (const egg of eggsData.data) {
                        nestsText += `• ${egg.attributes.name}\n`;
                      }
                    } else {
                      nestsText += "No eggs available for this nest.";
                    }
                  }
                } else {
                  // Show list of nests
                  nestsText += "Select a nest from the dropdown above to view its eggs.\n\n";
                  nestsText += "**Available Nests:**\n";
                  for (const nest of nestsData.data) {
                    nestsText += `• ${nest.attributes.name}\n`;
                  }
                }

                nestsContainer.addTextDisplayComponents(text =>
                  text.setContent(nestsText)
                );
              } else {
                nestsContainer.addTextDisplayComponents(text =>
                  text.setContent("No nests available.")
                );
              }

              await i.editReply({
                components: [ nestsContainer ],
                flags: MessageFlags.IsComponentsV2
              });
            }

          } else if (i.customId === "nest-selection") {
            await i.deferUpdate();
            const nestId = i.values[0];
            selectedNestId = nestId;

            if (nestId !== "none") {
              eggsData = await getEggs(parseInt(nestId, 10));

              if (!eggsData || !eggsData.data) {
                const errorContainer = new ContainerBuilder()
                  .setAccentColor(COLORS.DISABLED)
                  .addActionRowComponents(actionRow =>
                    actionRow.setComponents(buildCategorySelectMenu("nests"))
                  )
                  .addActionRowComponents(actionRow =>
                    actionRow.setComponents(buildNestSelectMenu(nestsData, nestId))
                  )
                  .addTextDisplayComponents(text =>
                    text.setContent(getErrorMessage("CLIENT_API_FAILURE"))
                  );

                await i.editReply({
                  components: [ errorContainer ],
                  flags: MessageFlags.IsComponentsV2
                });
                return;
              }

              const nestsContainer = new ContainerBuilder()
                .setAccentColor(COLORS.PRIMARY)
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(buildCategorySelectMenu("nests"))
                )
                .addActionRowComponents(actionRow =>
                  actionRow.setComponents(buildNestSelectMenu(nestsData, nestId))
                );

              let nestsText = "";
              const selectedNest = nestsData.data.find(n => n.attributes.id.toString() === nestId);
              if (selectedNest) {
                nestsText += `**Selected Nest:** ${selectedNest.attributes.name}\n\n`;
                nestsText += "**Available Eggs:**\n";
              }

              if (eggsData && eggsData.data && eggsData.data.length > 0) {
                for (const egg of eggsData.data) {
                  nestsText += `• ${egg.attributes.name}\n`;
                }
              } else {
                nestsText += "No eggs available for this nest.";
              }

              nestsContainer.addTextDisplayComponents(text =>
                text.setContent(nestsText)
              );

              await i.editReply({
                components: [ nestsContainer ],
                flags: MessageFlags.IsComponentsV2
              });
            }
          }
        } catch (error) {
          console.error("Error handling interaction:", error);
          const errorResponse = {
            content: "An error occurred while processing your request.",
            ephemeral: true
          };

          if (i.replied || i.deferred) {
            await i.followUp(errorResponse).catch(() => { });
          } else {
            await i.reply(errorResponse).catch(() => { });
          }
        }
      });

      collector.on("end", async (collected, reason) => {
        if (reason === "idle") {
          await interaction.editReply({
            components: [ createDisabledMenu() ],
            flags: MessageFlags.IsComponentsV2
          }).catch(() => { });
        }
      });

    } catch (error) {
      console.error("Error in service information command:", error);
      const errorMessage = {
        content: "An error occurred while loading service information.",
        ephemeral: true
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage).catch(() => { });
      } else {
        await interaction.reply(errorMessage).catch(() => { });
      }
    }
  }
};
