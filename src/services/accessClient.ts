import fs from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
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

function toPublicKey(value: unknown): PublicKey | undefined {
  if (!value) {
    return undefined;
  }

  if (value instanceof PublicKey) {
    return value;
  }

  if (typeof value === "string") {
    try {
      return new PublicKey(value);
    } catch {
      return undefined;
    }
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    if (value.length !== 32) {
      return undefined;
    }
    try {
      return new PublicKey(value);
    } catch {
      return undefined;
    }
  }

  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }

  const toBase58 = rec.toBase58;
  if (typeof toBase58 === "function") {
    try {
      const maybe = Reflect.apply(toBase58, value, []);
      if (typeof maybe === "string") {
        return new PublicKey(maybe);
      }
    } catch {
      return undefined;
    }
  }

  if (typeof rec.publicKey === "string") {
    return toPublicKey(rec.publicKey);
  }

  return undefined;
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
  private anchorProvider: unknown;
  private readonly connection: Connection;
  private readonly onchainSigner?: Keypair;
  private readonly accessProgramId = new PublicKey(config.programs.access);
  private readonly reputationProgramId = new PublicKey(config.programs.reputation);
  private readonly verificationProgramId = new PublicKey(config.programs.verification);
  private readonly recoveredDaoIdCache = new Map<string, string>();

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

  private async getAnchorProvider(): Promise<unknown | undefined> {
    if (this.anchorProvider) {
      return this.anchorProvider;
    }

    try {
      const anchor = (await import("@coral-xyz/anchor")) as Record<string, unknown>;
      const AnchorProvider = anchor.AnchorProvider;
      if (typeof AnchorProvider !== "function") {
        return undefined;
      }

      const signer = this.onchainSigner ?? Keypair.generate();
      const wallet = {
        publicKey: signer.publicKey,
        signTransaction: async (tx: unknown) => {
          const rec = asRecord(tx);
          const partialSign = rec?.partialSign;
          if (typeof partialSign === "function") {
            Reflect.apply(partialSign, tx, [signer]);
          }
          return tx;
        },
        signAllTransactions: async (txs: unknown[]) => {
          for (const tx of txs) {
            const rec = asRecord(tx);
            const partialSign = rec?.partialSign;
            if (typeof partialSign === "function") {
              Reflect.apply(partialSign, tx, [signer]);
            }
          }
          return txs;
        }
      };

      this.anchorProvider = Reflect.construct(AnchorProvider, [
        this.connection,
        wallet,
        {
          commitment: "confirmed",
          preflightCommitment: "confirmed"
        }
      ]);
      return this.anchorProvider;
    } catch {
      return undefined;
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
      ["GpassClient"],
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
        const anchorProvider = await this.getAnchorProvider();
        if (anchorProvider) {
          try {
            const instance = Reflect.construct(ctor, [anchorProvider, this.accessProgramId]);
            candidates.push(instance);
            continue;
          } catch {
            // Ignore constructor mismatch and continue.
          }
        }

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

  private async fetchGateObject(gateIdOrAlias: string): Promise<unknown> {
    const gateId = await this.resolveGateId(gateIdOrAlias);
    const gatePublicKey = toPublicKey(gateId);

    const argsVariants: unknown[][] = [
      [{ gateId }],
      [{ accessId: gateId }],
      [{ id: gateId }],
      [gateId]
    ];

    if (gatePublicKey) {
      argsVariants.unshift([{ gateId: gatePublicKey }], [{ accessId: gatePublicKey }], [gatePublicKey]);
    }

    return this.invokeFirst(
      ["fetchAccess", "fetchGate", "getAccess", "getGate", "fetchAccessById", "gateById", "accessById"],
      argsVariants,
      "Unable to fetch gate account"
    );
  }

  private extractGateRecord(raw: unknown): Record<string, unknown> | undefined {
    const rec = asRecord(raw);
    if (!rec) {
      return undefined;
    }

    if ("criteria" in rec || "metadataUri" in rec || "accessId" in rec || "gateId" in rec) {
      return rec;
    }

    const account = asRecord(rec.account);
    if (account) {
      return account;
    }

    return rec;
  }

  private collectNamedPublicKeys(root: unknown, fieldNames: ReadonlySet<string>): PublicKey[] {
    const out: PublicKey[] = [];
    const seenObjects = new Set<object>();

    const walk = (value: unknown, depth: number): void => {
      if (depth > 8 || value === null || value === undefined) {
        return;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          walk(entry, depth + 1);
        }
        return;
      }

      if (typeof value !== "object") {
        return;
      }

      const obj = value as object;
      if (seenObjects.has(obj)) {
        return;
      }
      seenObjects.add(obj);

      const rec = asRecord(value);
      if (!rec) {
        return;
      }

      for (const [k, v] of Object.entries(rec)) {
        if (fieldNames.has(k)) {
          const pk = toPublicKey(v);
          if (pk) {
            out.push(pk);
          }
        }
        walk(v, depth + 1);
      }
    };

    walk(root, 0);

    const deduped = new Map<string, PublicKey>();
    for (const pk of out) {
      deduped.set(pk.toBase58(), pk);
    }
    return Array.from(deduped.values());
  }

  private async recoverDaoIdFromSeededAccount(params: {
    sourcePda: PublicKey;
    seedPrefix: "config" | "space";
    programId: PublicKey;
  }): Promise<string | undefined> {
    const cacheKey = `${params.seedPrefix}:${params.sourcePda.toBase58()}`;
    const cached = this.recoveredDaoIdCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const info = await this.connection.getAccountInfo(params.sourcePda, "confirmed");
    if (!info) {
      return undefined;
    }

    const data = info.data;
    const scanLength = Math.min(data.length, 2048);
    if (scanLength < 32) {
      return undefined;
    }

    for (let i = 0; i <= scanLength - 32; i += 1) {
      const maybeDaoBytes = data.subarray(i, i + 32);

      let maybeDao: PublicKey;
      try {
        maybeDao = new PublicKey(maybeDaoBytes);
      } catch {
        continue;
      }

      const [derived] = PublicKey.findProgramAddressSync(
        [Buffer.from(params.seedPrefix), maybeDao.toBuffer()],
        params.programId
      );

      if (derived.equals(params.sourcePda)) {
        const daoId = maybeDao.toBase58();
        this.recoveredDaoIdCache.set(cacheKey, daoId);
        return daoId;
      }
    }

    return undefined;
  }

  async getGateDaoId(gateIdOrAlias: string): Promise<string | undefined> {
    const raw = await this.fetchGateObject(gateIdOrAlias);
    const gate = this.extractGateRecord(raw);
    if (!gate) {
      return undefined;
    }

    const directCandidates = [
      gate.daoId,
      gate.dao_id,
      gate.dao,
      asRecord(gate.metadata)?.daoId,
      asRecord(gate.metadata)?.dao_id
    ];

    for (const candidate of directCandidates) {
      const pk = toPublicKey(candidate);
      if (pk) {
        return pk.toBase58();
      }
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }

    const criteria = asRecord(gate.criteria) ?? asRecord(asRecord(gate.account)?.criteria);
    if (!criteria) {
      return undefined;
    }

    const vineConfigCandidates = this.collectNamedPublicKeys(criteria, new Set(["vineConfig"]));
    for (const vineConfig of vineConfigCandidates) {
      const daoId = await this.recoverDaoIdFromSeededAccount({
        sourcePda: vineConfig,
        seedPrefix: "config",
        programId: this.reputationProgramId
      });
      if (daoId) {
        return daoId;
      }
    }

    const grapeSpaceCandidates = this.collectNamedPublicKeys(criteria, new Set(["grapeSpace"]));
    for (const grapeSpace of grapeSpaceCandidates) {
      const daoId = await this.recoverDaoIdFromSeededAccount({
        sourcePda: grapeSpace,
        seedPrefix: "space",
        programId: this.verificationProgramId
      });
      if (daoId) {
        return daoId;
      }
    }

    return undefined;
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
    const raw = await this.fetchGateObject(gateIdOrAlias);
    const rec = this.extractGateRecord(raw);
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
