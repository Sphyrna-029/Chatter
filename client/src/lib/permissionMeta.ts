import type { PermissionName, RolePermissions } from "./api";

export interface PermissionMeta {
  key: PermissionName;
  label: string;
  /** One line explaining what the permission actually lets someone do. A bare
   *  label like "Manage Emojis" leaves people guessing at its blast radius. */
  description: string;
  /** Elevated permissions are visually separated so they aren't granted by
   *  accident alongside the everyday ones. */
  elevated?: boolean;
  /** Meaningful as a per-channel overwrite. Room-wide powers are not. */
  channelScoped?: boolean;
}

export interface PermissionSection {
  title: string;
  permissions: PermissionMeta[];
}

export const PERMISSION_SECTIONS: PermissionSection[] = [
  {
    title: "General",
    permissions: [
      {
        key: "view_channel",
        label: "View Channels",
        description: "See channels and read their history.",
        channelScoped: true,
      },
      {
        key: "send_messages",
        label: "Send Messages",
        description: "Post in text channels.",
        channelScoped: true,
      },
      {
        key: "attach_files",
        label: "Attach Files",
        description: "Upload images, video, and other files.",
        channelScoped: true,
      },
      {
        key: "embed_links",
        label: "Embed Links",
        description: "Post rich embeds alongside a message.",
        channelScoped: true,
      },
      {
        key: "add_reactions",
        label: "Add Reactions",
        description: "React to messages with emoji.",
        channelScoped: true,
      },
    ],
  },
  {
    title: "Voice",
    permissions: [
      {
        key: "connect",
        label: "Join Voice",
        description: "Enter voice channels and listen.",
        channelScoped: true,
      },
      {
        key: "speak",
        label: "Speak",
        description: "Transmit audio once connected. Enforced at the server, not the mic button.",
        channelScoped: true,
      },
    ],
  },
  {
    title: "Moderation",
    permissions: [
      {
        key: "manage_messages",
        label: "Manage Messages",
        description: "Delete anyone's messages, and pin or unpin them.",
        elevated: true,
        channelScoped: true,
      },
      {
        key: "kick_members",
        label: "Kick Members",
        description: "Remove members from the room. They can rejoin.",
        elevated: true,
      },
      {
        key: "ban_members",
        label: "Ban Members",
        description: "Remove members and stop them returning. Also lets them see and lift bans.",
        elevated: true,
      },
      {
        key: "mention_everyone",
        label: "Mention Roles",
        description: "Ping a whole role. Without it, role mentions still render but notify nobody.",
        elevated: true,
      },
    ],
  },
  {
    title: "Management",
    permissions: [
      {
        key: "manage_channels",
        label: "Manage Channels",
        description: "Create, edit, and delete channels, categories, and room settings.",
        elevated: true,
      },
      {
        key: "manage_roles",
        label: "Manage Roles",
        description:
          "Create and assign roles below their own. Cannot grant a permission they don't hold.",
        elevated: true,
      },
      {
        key: "manage_webhooks",
        label: "Manage Webhooks",
        description: "Create and remove webhooks that post into this room.",
        elevated: true,
      },
      {
        key: "manage_emojis",
        label: "Manage Emojis",
        description: "Add and remove the room's custom emoji.",
        elevated: true,
      },
    ],
  },
];

export const ALL_PERMISSIONS: PermissionMeta[] = PERMISSION_SECTIONS.flatMap(
  (s) => s.permissions,
);

/** Only the permissions that mean something scoped to a single channel. */
export const CHANNEL_PERMISSION_SECTIONS: PermissionSection[] = PERMISSION_SECTIONS.map(
  (s) => ({ ...s, permissions: s.permissions.filter((p) => p.channelScoped) }),
).filter((s) => s.permissions.length > 0);

/** Every permission off — the starting point for a role that only adds. */
export const NO_PERMISSIONS: RolePermissions = Object.fromEntries(
  ALL_PERMISSIONS.map((p) => [p.key, false]),
) as unknown as RolePermissions;

/** The baseline a member holds with no roles, mirroring the server's default. */
export const DEFAULT_PERMISSIONS: RolePermissions = {
  ...NO_PERMISSIONS,
  view_channel: true,
  send_messages: true,
  attach_files: true,
  embed_links: true,
  add_reactions: true,
  connect: true,
  speak: true,
};
