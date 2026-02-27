import fs from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { AccessCheckResult, CheckSource } from "../types.js";

interface CheckAccessInput {
  gateId: string;
  walletPubkey: string;
  mode: CheckSource;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getNested(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const part of path) {
    const rec = asRecord(current);
    if (!rec || !(part in rec)) {
      return undefined;
    }
    current = rec[part];
  }
  return current;
}

function normalizeResult(raw: unknown, mode: CheckSource): AccessCheckResult {
  if (typeof raw === "boolean") {
    return { passed: raw, source: mode };
  }

  const rec = asRecord(raw);
  if (!rec) {
    return {
      passed: false,
      source: mode,
      reason: "SDK returned a non-object check response."
    };
  }

  const passed =
    typeof rec.passed === "boolean"
      ? rec.passed
      : typeof rec.allowed === "boolean"
        ? rec.allowed
        : typeof rec.success === "boolean"
          ? rec.success
          : false;

  const reason =
    (typeof rec.reason === "string" && rec.reason) ||
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    undefined;

  const proofCandidate =
    asRecord(rec.proof) || asRecord(rec.details) || asRecord(rec.result) || asRecord(rec.meta);

  return {
    passed,
    source: mode,
    reason,
    proof: proofCandidate
  };
}

export class AccessClient {
  private sdkRoot: unknown;
  private readonly connection: Connection;
  private readonly onchainSigner?: Keypair;

  constructor() {
    this.connection = new Connection(config.rpcEndpoint, "confirmed");
    this.onchainSigner = this.loadOnchainSigner();
  }

  private loadOnchainSigner(): Keypair | undefined {
    if (!config.onchainCheckerKeypairPath) {
      return undefined;
    }

    try {
      const file = fs.readFileSync(config.onchainCheckerKeypairPath, "utf8");
      const secret = JSON.parse(file) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    } catch (err) {
      logger.warn({ err }, "Failed to load on-chain checker keypair. Falling back to simulation only.");
      return undefined;
    }
  }

  private async loadSdkRoot(): Promise<unknown> {
    if (this.sdkRoot) {
      return this.sdkRoot;
    }

    try {
      const mod = (await import("@grapenpm/grape-access-sdk")) as Record<string, unknown>;
      this.sdkRoot = mod.default ?? mod;
      return this.sdkRoot;
    } catch (err) {
      throw new Error(`Unable to load @grapenpm/grape-access-sdk: ${String(err)}`);
    }
  }

  private async candidateObjects(): Promise<unknown[]> {
    const root = await this.loadSdkRoot();
    const candidates: unknown[] = [root];

    const nestedRoots = [
      ["access"],
      ["client"],
      ["sdk"],
      ["grape"],
      ["grapeAccess"]
    ];

    for (const path of nestedRoots) {
      const value = getNested(root, path);
      if (value) {
        candidates.push(value);
      }
    }

    const constructables = [
      ["AccessClient"],
      ["GrapeAccessClient"],
      ["SDK"],
      ["GrapeAccessSDK"]
    ];

    for (const path of constructables) {
      const ctor = getNested(root, path);
      if (typeof ctor !== "function") {
        continue;
      }

      try {
        const instance = Reflect.construct(ctor, [
          {
            connection: this.connection,
            rpcEndpoint: config.rpcEndpoint,
            cluster: config.cluster,
            programs: config.programs,
            signer: this.onchainSigner
          }
        ]);
        candidates.push(instance);
      } catch {
        try {
          const instance = Reflect.construct(ctor, [this.connection]);
          candidates.push(instance);
        } catch {
          // Ignore constructor mismatch and continue.
        }
      }
    }

    const factoryNames = ["createClient", "createAccessClient", "createSDK"];
    for (const factoryName of factoryNames) {
      const factory = getNested(root, [factoryName]);
      if (typeof factory !== "function") {
        continue;
      }

      try {
        const produced = await Promise.resolve(
          Reflect.apply(factory, root, [
            {
              connection: this.connection,
              rpcEndpoint: config.rpcEndpoint,
              cluster: config.cluster,
              programs: config.programs,
              signer: this.onchainSigner
            }
          ])
        );
        if (produced) {
          candidates.push(produced);
        }
      } catch {
        // Ignore factory mismatch and continue.
      }
    }

    return candidates;
  }

  private async invokeFirst(
    methodNames: string[],
    argsVariants: unknown[][],
    errorLabel: string
  ): Promise<unknown> {
    const candidates = await this.candidateObjects();
    const errors: string[] = [];

    for (const candidate of candidates) {
      const rec = asRecord(candidate);
      if (!rec) {
        continue;
      }

      for (const methodName of methodNames) {
        const maybeMethod = rec[methodName];
        if (typeof maybeMethod !== "function") {
          continue;
        }

        for (const args of argsVariants) {
          try {
            return await Promise.resolve(Reflect.apply(maybeMethod, candidate, args));
          } catch (err) {
            errors.push(`${methodName}(${args.length}) failed: ${String(err)}`);
          }
        }
      }
    }

    throw new Error(`${errorLabel}. Tried SDK methods: ${methodNames.join(", ")}. Details: ${errors.slice(0, 5).join(" | ")}`);
  }

  async resolveGateId(gateIdOrAlias: string): Promise<string> {
    const argsVariants = [
      [{ gateId: gateIdOrAlias }],
      [{ alias: gateIdOrAlias }],
      [gateIdOrAlias]
    ];

    try {
      const raw = await this.invokeFirst(
        ["resolveGateId", "resolveGate", "resolveAlias", "resolveGateAlias"],
        argsVariants,
        "Gate identifier resolution failed"
      );

      if (typeof raw === "string" && raw.length > 0) {
        return raw;
      }

      const rec = asRecord(raw);
      if (!rec) {
        return gateIdOrAlias;
      }

      const resolved =
        (typeof rec.gateId === "string" && rec.gateId) ||
        (typeof rec.id === "string" && rec.id) ||
        (typeof rec.gate === "string" && rec.gate) ||
        undefined;

      return resolved ?? gateIdOrAlias;
    } catch {
      return gateIdOrAlias;
    }
  }

  async getGateMetadataUri(gateIdOrAlias: string): Promise<string | undefined> {
    const gateId = await this.resolveGateId(gateIdOrAlias);

    const argsVariants = [[{ gateId }], [{ id: gateId }], [gateId]];
    const raw = await this.invokeFirst(
      ["getGate", "fetchGate", "getAccessGate", "gateById"],
      argsVariants,
      "Unable to fetch gate metadata"
    );

    const rec = asRecord(raw);
    if (!rec) {
      return undefined;
    }

    const direct =
      (typeof rec.metadataUri === "string" && rec.metadataUri) ||
      (typeof rec.uri === "string" && rec.uri) ||
      undefined;
    if (direct) {
      return direct;
    }

    const nestedMeta = asRecord(rec.metadata);
    if (!nestedMeta) {
      return undefined;
    }

    const nestedUri =
      (typeof nestedMeta.uri === "string" && nestedMeta.uri) ||
      (typeof nestedMeta.metadataUri === "string" && nestedMeta.metadataUri) ||
      undefined;

    return nestedUri;
  }

  async checkAccess(input: CheckAccessInput): Promise<AccessCheckResult> {
    const gateId = await this.resolveGateId(input.gateId);
    const shouldWrite = input.mode === "onchain_write";

    if (shouldWrite && !this.onchainSigner) {
      return {
        passed: false,
        source: "onchain_write",
        reason:
          "On-chain write mode requested, but ONCHAIN_CHECKER_KEYPAIR_PATH is not configured or invalid."
      };
    }

    const argsVariants = [
      [
        {
          gateId,
          wallet: input.walletPubkey,
          walletPubkey: input.walletPubkey,
          mode: shouldWrite ? "write" : "simulate",
          write: shouldWrite,
          writeRecord: shouldWrite,
          cluster: config.cluster,
          connection: this.connection,
          signer: this.onchainSigner,
          programs: config.programs
        }
      ],
      [gateId, input.walletPubkey, { write: shouldWrite, cluster: config.cluster }],
      [input.walletPubkey, gateId, { write: shouldWrite, cluster: config.cluster }]
    ];

    const raw = await this.invokeFirst(
      ["checkAccess", "checkGateAccess", "check", "canAccess", "evaluateAccess"],
      argsVariants,
      "Access check failed"
    );

    return normalizeResult(raw, shouldWrite ? "onchain_write" : "simulate");
  }
}
