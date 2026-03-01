import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

const adminOnlyPermission = PermissionFlagsBits.Administrator;
const adminOrGuildManagePermission = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild;
const moderatorPermissionMask =
  PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ModerateMembers;

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("setup-gate")
    .setDescription("Map a gate to a guild role")
    .setDefaultMemberPermissions(adminOrGuildManagePermission)
    .addStringOption((opt) =>
      opt.setName("gate_id").setDescription("Gate identifier or alias").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("pass_role_id").setDescription("Role ID to assign on pass").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("guild_id")
        .setDescription("Discord guild ID (optional in-server; auto-detected)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("dao_id")
        .setDescription("Fallback DAO ID for verification/reputation links")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("verification_dao_id")
        .setDescription("DAO ID used for verification identity lookup/link")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("reputation_dao_id")
        .setDescription("DAO ID used for reputation link/display")
        .setRequired(false)
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
    .setDescription("Check your linked wallet against configured gate(s)")
    .setDefaultMemberPermissions(adminOnlyPermission),

  new SlashCommandBuilder()
    .setName("debug-identity")
    .setDescription("Debug identity/link account resolution for one gate")
    .setDefaultMemberPermissions(adminOnlyPermission)
    .addStringOption((opt) =>
      opt.setName("gate_id").setDescription("Gate identifier or alias").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("link-identity")
    .setDescription("Manually set identity/link PDAs for your checks in this guild")
    .setDefaultMemberPermissions(adminOnlyPermission)
    .addStringOption((opt) =>
      opt.setName("gate_id").setDescription("Gate identifier or alias").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("identity_pda").setDescription("Verification identity PDA").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("link_pda").setDescription("Verification link PDA (optional)").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("link-wallet")
    .setDescription("Manually link your wallet for this server (testing)")
    .setDefaultMemberPermissions(adminOnlyPermission)
    .addStringOption((opt) =>
      opt.setName("wallet").setDescription("Wallet pubkey").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("reset-me")
    .setDescription("Reset your wallet link and identity overrides for this server")
    .setDefaultMemberPermissions(adminOnlyPermission),

  new SlashCommandBuilder()
    .setName("sync-gate")
    .setDescription("Batch sync role assignments for a gate in this guild")
    .setDefaultMemberPermissions(moderatorPermissionMask)
    .addStringOption((opt) =>
      opt.setName("gate_id").setDescription("Gate identifier or alias").setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt.setName("dry_run").setDescription("If true, report actions without changing roles")
    )
] as const;

export const commandDefinitions = commandBuilders.map((cmd) => cmd.toJSON());
