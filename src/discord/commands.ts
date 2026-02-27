import { SlashCommandBuilder } from "discord.js";

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("setup-gate")
    .setDescription("Map a gate to a guild role")
    .addStringOption((opt) =>
      opt.setName("gate_id").setDescription("Gate identifier or alias").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("guild_id").setDescription("Discord guild ID").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("pass_role_id").setDescription("Role ID to assign on pass").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("fail_action")
        .setDescription("Role action when check fails")
        .setRequired(false)
        .addChoices(
          { name: "none", value: "none" },
          { name: "remove_role", value: "remove_role" }
        )
    ),

  new SlashCommandBuilder().setName("verify").setDescription("Get verification links for configured gate(s)"),

  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Check if a wallet currently passes a gate")
    .addStringOption((opt) =>
      opt.setName("user_wallet").setDescription("Wallet pubkey").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("gate_id").setDescription("Gate identifier or alias").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("sync-gate")
    .setDescription("Batch sync role assignments for a gate in this guild")
    .addStringOption((opt) =>
      opt.setName("gate_id").setDescription("Gate identifier or alias").setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt.setName("dry_run").setDescription("If true, report actions without changing roles")
    )
] as const;

export const commandDefinitions = commandBuilders.map((cmd) => cmd.toJSON());
