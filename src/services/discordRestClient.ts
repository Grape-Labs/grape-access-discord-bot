import { config } from "../config.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

interface DiscordMember {
  user: { id: string };
  roles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class DiscordRestClient {
  private readonly token: string;

  constructor() {
    this.token = config.discordBotToken;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<{ status: number; body?: T }> {
    const response = await fetch(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });

    if (response.status === 204) {
      return { status: 204 };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const reason = isRecord(parsed) && typeof parsed.message === "string" ? parsed.message : response.statusText;
      throw new Error(`Discord API ${path} failed (${response.status}): ${reason}`);
    }

    return { status: response.status, body: parsed as T };
  }

  async fetchMember(guildId: string, userId: string): Promise<DiscordMember | null> {
    const response = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}`, {
      headers: {
        Authorization: `Bot ${this.token}`
      }
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch member ${userId}: ${response.status} ${text}`);
    }

    return (await response.json()) as DiscordMember;
  }

  async fetchRole(guildId: string, roleId: string): Promise<boolean> {
    const response = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/roles/${roleId}`, {
      headers: {
        Authorization: `Bot ${this.token}`
      }
    });

    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch role ${roleId}: ${response.status} ${text}`);
    }

    return true;
  }

  async addRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    await this.request(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: "PUT",
      headers: {
        "X-Audit-Log-Reason": reason
      }
    });
  }

  async removeRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    await this.request(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      method: "DELETE",
      headers: {
        "X-Audit-Log-Reason": reason
      }
    });
  }
}
