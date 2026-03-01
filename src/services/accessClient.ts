import fs from "node:fs";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { AccessCheckResult, CheckSource } from "../types.js";

interface CheckAccessInput {
  gateId: string;
  walletPubkey: string;
  mode: CheckSource;
}

export interface DiscordVerificationStatus {
  identityFound: boolean;
  linksFound: number;
  daoId: string;
  matchedIdentifier?: string;
  identityPda?: string;
  reason?: string;
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

function sha256Bytes(input: string): Uint8Array {
  return createHash("sha256").update(input, "utf8").digest();
}

function sha256Buffer(input: Uint8Array | Buffer): Uint8Array {
  return createHash("sha256").update(input).digest();
}

function parseSpaceSalt(spaceData: Uint8Array): Uint8Array | undefined {
  // Layout: disc(8) + version(1) + dao(32) + authority(32) + attestor(32) + is_frozen(1) + bump(1) + salt(32)
  const offset = 8 + 1 + 32 + 32 + 32 + 1 + 1;
  if (spaceData.length < offset + 32) {
    return undefined;
  }
  return spaceData.slice(offset, offset + 32);
}

function normalizeResult(raw: unknown, mode: CheckSource): AccessCheckResult {
  if (typeof raw === "boolean") {
    return { passed: raw, source: mode };
  }

  if (typeof raw === "string" && raw.length > 0) {
    return {
      passed: true,
      source: mode,
      proof: { tx: raw }
    };
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

  private async withRpcTimeout<T>(label: string, task: () => Promise<T>): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${config.rpcRequestTimeoutMs}ms (${config.rpcEndpoint})`));
        }, config.rpcRequestTimeoutMs);
      });

      return await Promise.race([task(), timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
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

    return this.withRpcTimeout("fetchGateObject", () =>
      this.invokeFirst(
        ["fetchAccess", "fetchGate", "getAccess", "getGate", "fetchAccessById", "gateById", "accessById"],
        argsVariants,
        "Unable to fetch gate account"
      )
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

    const info = await this.withRpcTimeout("getAccountInfo", () =>
      this.connection.getAccountInfo(params.sourcePda, "confirmed")
    );
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

  async getGateDaoIds(gateIdOrAlias: string): Promise<{
    verificationDaoId?: string;
    reputationDaoId?: string;
    daoId?: string;
  }> {
    const raw = await this.fetchGateObject(gateIdOrAlias);
    const gate = this.extractGateRecord(raw);
    if (!gate) {
      return {};
    }

    const directFallbackCandidates = [
      gate.daoId,
      gate.dao_id,
      gate.dao,
      asRecord(gate.metadata)?.daoId,
      asRecord(gate.metadata)?.dao_id
    ];
    const directVerificationCandidates = [
      gate.verificationDaoId,
      gate.verification_dao_id,
      asRecord(gate.metadata)?.verificationDaoId,
      asRecord(gate.metadata)?.verification_dao_id
    ];
    const directReputationCandidates = [
      gate.reputationDaoId,
      gate.reputation_dao_id,
      asRecord(gate.metadata)?.reputationDaoId,
      asRecord(gate.metadata)?.reputation_dao_id
    ];

    const pickDao = (candidates: unknown[]): string | undefined => {
      for (const candidate of candidates) {
        const pk = toPublicKey(candidate);
        if (pk) {
          return pk.toBase58();
        }
        if (typeof candidate === "string" && candidate.length > 0) {
          return candidate;
        }
      }
      return undefined;
    };

    const fallbackDaoId = pickDao(directFallbackCandidates);
    let verificationDaoId = pickDao(directVerificationCandidates);
    let reputationDaoId = pickDao(directReputationCandidates);

    const criteria = asRecord(gate.criteria) ?? asRecord(asRecord(gate.account)?.criteria);
    if (criteria) {
      if (!reputationDaoId) {
        const vineConfigCandidates = this.collectNamedPublicKeys(criteria, new Set(["vineConfig"]));
        for (const vineConfig of vineConfigCandidates) {
          const daoId = await this.recoverDaoIdFromSeededAccount({
            sourcePda: vineConfig,
            seedPrefix: "config",
            programId: this.reputationProgramId
          });
          if (daoId) {
            reputationDaoId = daoId;
            break;
          }
        }
      }

      if (!verificationDaoId) {
        const grapeSpaceCandidates = this.collectNamedPublicKeys(criteria, new Set(["grapeSpace"]));
        for (const grapeSpace of grapeSpaceCandidates) {
          const daoId = await this.recoverDaoIdFromSeededAccount({
            sourcePda: grapeSpace,
            seedPrefix: "space",
            programId: this.verificationProgramId
          });
          if (daoId) {
            verificationDaoId = daoId;
            break;
          }
        }
      }
    }

    return {
      verificationDaoId: verificationDaoId ?? fallbackDaoId,
      reputationDaoId: reputationDaoId ?? fallbackDaoId,
      daoId: fallbackDaoId
    };
  }

  async getGateDaoId(gateIdOrAlias: string): Promise<string | undefined> {
    const ids = await this.getGateDaoIds(gateIdOrAlias);
    const directCandidates = [ids.verificationDaoId, ids.reputationDaoId, ids.daoId];
    for (const candidate of directCandidates) {
      const pk = toPublicKey(candidate);
      if (pk) {
        return pk.toBase58();
      }
      if (typeof candidate === "string" && candidate.length > 0) {
        return candidate;
      }
    }
    return undefined;
  }

  private parseWalletCandidatesFromLinkAccountData(data: Buffer): PublicKey[] {
    const candidates: PublicKey[] = [];

    const candidateOffsets = [8 + 1 + 32, 8 + 1 + 32 + 32, 8 + 32, 8 + 32 + 32];

    for (const offset of candidateOffsets) {
      if (data.length < offset + 32) {
        continue;
      }

      const slice = data.subarray(offset, offset + 32);
      const isZero = slice.every((x) => x === 0);
      if (isZero || !PublicKey.isOnCurve(slice)) {
        continue;
      }

      try {
        candidates.push(new PublicKey(slice));
      } catch {
        // Ignore invalid candidate.
      }
    }

    // Also scan aligned 32-byte windows as a fallback for unknown layout changes.
    for (let offset = 8; offset + 32 <= data.length; offset += 32) {
      const slice = data.subarray(offset, offset + 32);
      const isZero = slice.every((x) => x === 0);
      if (isZero || !PublicKey.isOnCurve(slice)) {
        continue;
      }

      try {
        candidates.push(new PublicKey(slice));
      } catch {
        // Ignore invalid candidate.
      }
    }

    const deduped = new Map<string, PublicKey>();
    for (const candidate of candidates) {
      deduped.set(candidate.toBase58(), candidate);
    }
    return Array.from(deduped.values());
  }

  private walletHashCandidates(wallet: PublicKey): Uint8Array[] {
    const bytes = wallet.toBytes();
    const base58 = wallet.toBase58();

    const hashes = [
      sha256Buffer(bytes),
      sha256Bytes(base58),
      sha256Bytes(base58.toLowerCase()),
      sha256Bytes(Buffer.from(bytes).toString("hex"))
    ];

    const deduped = new Map<string, Uint8Array>();
    for (const hash of hashes) {
      deduped.set(Buffer.from(hash).toString("hex"), hash);
    }
    return Array.from(deduped.values());
  }

  async getDiscordVerificationStatus(params: {
    daoId: string;
    discordUserId?: string;
    identifiers?: string[];
  }): Promise<DiscordVerificationStatus> {
    let gvr: Record<string, unknown>;
    try {
      gvr = (await import("@grapenpm/grape-verification-registry")) as Record<string, unknown>;
    } catch {
      return {
        identityFound: false,
        linksFound: 0,
        daoId: params.daoId,
        reason: "verification_registry_sdk_unavailable"
      };
    }

    const deriveSpacePda = gvr.deriveSpacePda;
    const deriveIdentityPda = gvr.deriveIdentityPda;
    const identityHash = gvr.identityHash;
    const fetchLinksForIdentity = gvr.fetchLinksForIdentity;
    const verificationPlatform = gvr.VerificationPlatform as Record<string, unknown> | undefined;
    const tagDiscord = gvr.TAG_DISCORD;

    if (
      typeof deriveSpacePda !== "function" ||
      typeof deriveIdentityPda !== "function" ||
      typeof identityHash !== "function" ||
      typeof fetchLinksForIdentity !== "function" ||
      typeof tagDiscord !== "string"
    ) {
      return {
        identityFound: false,
        linksFound: 0,
        daoId: params.daoId,
        reason: "verification_registry_exports_missing"
      };
    }

    const discordPlatformSeedRaw = verificationPlatform?.Discord;
    const discordPlatformSeed =
      typeof discordPlatformSeedRaw === "number" ? discordPlatformSeedRaw : 0;

    let daoPk: PublicKey;
    try {
      daoPk = new PublicKey(params.daoId);
    } catch {
      return {
        identityFound: false,
        linksFound: 0,
        daoId: params.daoId,
        reason: "invalid_dao_id"
      };
    }

    let spacePda: PublicKey;
    try {
      const res = Reflect.apply(deriveSpacePda, gvr, [daoPk]) as [PublicKey, number];
      spacePda = res[0];
    } catch {
      return {
        identityFound: false,
        linksFound: 0,
        daoId: params.daoId,
        reason: "space_pda_derivation_failed"
      };
    }

    const spaceInfo = await this.withRpcTimeout("getAccountInfo(space)", () =>
      this.connection.getAccountInfo(spacePda, "confirmed")
    );
    if (!spaceInfo) {
      return {
        identityFound: false,
        linksFound: 0,
        daoId: params.daoId,
        reason: "space_not_found"
      };
    }

    const salt = parseSpaceSalt(spaceInfo.data);
    if (!salt) {
      return {
        identityFound: false,
        linksFound: 0,
        daoId: params.daoId,
        reason: "space_salt_parse_failed"
      };
    }

    const identifiersRaw = [
      ...(params.identifiers ?? []),
      ...(params.discordUserId ? [params.discordUserId] : [])
    ];
    const identifiers = Array.from(
      new Set(identifiersRaw.map((x) => x.trim()).filter((x) => x.length > 0))
    );
    if (identifiers.length === 0) {
      return {
        identityFound: false,
        linksFound: 0,
        daoId: params.daoId,
        reason: "no_identifiers"
      };
    }

    for (const identifier of identifiers) {
      try {
        const idHash = Reflect.apply(identityHash, gvr, [salt, tagDiscord, identifier]) as Uint8Array;
        const [identityPda] = Reflect.apply(deriveIdentityPda, gvr, [
          spacePda,
          discordPlatformSeed,
          idHash
        ]) as [PublicKey, number];

        const identityInfo = await this.withRpcTimeout("getAccountInfo(identity)", () =>
          this.connection.getAccountInfo(identityPda, "confirmed")
        );
        if (!identityInfo) {
          continue;
        }

        const links = await this.withRpcTimeout("fetchLinksForIdentity", () =>
          Promise.resolve(Reflect.apply(fetchLinksForIdentity, gvr, [this.connection, identityPda]))
        );
        const linksFound = Array.isArray(links) ? links.length : 0;

        return {
          identityFound: true,
          linksFound,
          daoId: params.daoId,
          matchedIdentifier: identifier,
          identityPda: identityPda.toBase58()
        };
      } catch {
        // Continue with next identifier.
      }
    }

    return {
      identityFound: false,
      linksFound: 0,
      daoId: params.daoId,
      reason: "identity_not_found"
    };
  }

  async getVerifiedWalletForDiscordUser(params: {
    daoId: string;
    discordUserId?: string;
    identifiers?: string[];
  }): Promise<string | undefined> {
    let mod: Record<string, unknown>;
    try {
      mod = (await import("@grapenpm/grape-access-sdk")) as Record<string, unknown>;
    } catch {
      return undefined;
    }

    const findGrapeSpacePda = mod.findGrapeSpacePda;
    const findGrapeIdentityPda = mod.findGrapeIdentityPda;
    const findGrapeLinkPda = mod.findGrapeLinkPda;
    if (
      typeof findGrapeSpacePda !== "function" ||
      typeof findGrapeIdentityPda !== "function" ||
      typeof findGrapeLinkPda !== "function"
    ) {
      return undefined;
    }

    let daoPk: PublicKey;
    try {
      daoPk = new PublicKey(params.daoId);
    } catch {
      return undefined;
    }

    let spacePda: PublicKey;
    try {
      const res = (await Promise.resolve(
        Reflect.apply(findGrapeSpacePda, mod, [daoPk, this.verificationProgramId])
      )) as [PublicKey, number];
      spacePda = res[0];
    } catch {
      return undefined;
    }

    const identifiersRaw = [
      ...(params.identifiers ?? []),
      ...(params.discordUserId ? [params.discordUserId] : [])
    ];

    const identifiers = Array.from(
      new Set(
        identifiersRaw
          .map((x) => x.trim())
          .filter((x) => x.length > 0)
      )
    );

    if (identifiers.length === 0) {
      return undefined;
    }

    const hashInputs = identifiers.flatMap((raw) => {
      const lower = raw.toLowerCase();
      return [
        raw,
        lower,
        `discord:${raw}`,
        `discord:${lower}`,
        `discord_id:${raw}`,
        `discord_id:${lower}`
      ];
    });

    const uniqueHashes = Array.from(
      new Set(hashInputs.map((x) => Buffer.from(sha256Bytes(x)).toString("hex")))
    ).map((hex) => Uint8Array.from(Buffer.from(hex, "hex")));

    const platformSeedCandidates = [0, 1, 2, 3];
    const linkIdentityOffsets = [8 + 1, 8, 9, 40, 41];

    for (const platformSeed of platformSeedCandidates) {
      for (const idHash of uniqueHashes) {
        let identityPda: PublicKey;
        try {
          const res = (await Promise.resolve(
            Reflect.apply(findGrapeIdentityPda, mod, [
              spacePda,
              platformSeed,
              idHash,
              this.verificationProgramId
            ])
          )) as [PublicKey, number];
          identityPda = res[0];
        } catch {
          continue;
        }

        const identityInfo = await this.withRpcTimeout("getAccountInfo(identity)", () =>
          this.connection.getAccountInfo(identityPda, "confirmed")
        );
        if (!identityInfo) {
          continue;
        }

        const allLinks: Array<{ pubkey: PublicKey; account: { data: Buffer } }> = [];
        const seenLinkPdas = new Set<string>();

        for (const offset of linkIdentityOffsets) {
          const links = await this.withRpcTimeout("getProgramAccounts(link)", () =>
            this.connection.getProgramAccounts(this.verificationProgramId, {
              filters: [
                {
                  memcmp: {
                    offset,
                    bytes: identityPda.toBase58()
                  }
                }
              ]
            })
          );

          for (const link of links) {
            const k = link.pubkey.toBase58();
            if (seenLinkPdas.has(k)) {
              continue;
            }
            seenLinkPdas.add(k);
            allLinks.push(link as { pubkey: PublicKey; account: { data: Buffer } });
          }
        }

        for (const link of allLinks) {
          const walletCandidates = this.parseWalletCandidatesFromLinkAccountData(link.account.data);

          for (const walletCandidate of walletCandidates) {
            const hashCandidates = this.walletHashCandidates(walletCandidate);

            for (const walletHash of hashCandidates) {
              try {
                const [derivedLinkPda] = (await Promise.resolve(
                  Reflect.apply(findGrapeLinkPda, mod, [
                    identityPda,
                    walletHash,
                    this.verificationProgramId
                  ])
                )) as [PublicKey, number];

                if (derivedLinkPda.equals(link.pubkey)) {
                  return walletCandidate.toBase58();
                }
              } catch {
                // Ignore this hash form and continue.
              }
            }
          }
        }
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
    const source: CheckSource = shouldWrite ? "onchain_write" : "simulate";

    if (shouldWrite && !this.onchainSigner) {
      return {
        passed: false,
        source,
        reason:
          "On-chain write mode requested, but ONCHAIN_CHECKER_KEYPAIR_PATH is not configured or invalid."
      };
    }

    let gatePk: PublicKey;
    let walletPk: PublicKey;
    try {
      gatePk = new PublicKey(gateId);
      walletPk = new PublicKey(input.walletPubkey);
    } catch {
      return {
        passed: false,
        source,
        reason: "Invalid gate or wallet public key."
      };
    }

    const argsVariants = [
      [
        {
          accessId: gatePk,
          gateId,
          gate: gatePk,
          user: walletPk,
          wallet: walletPk,
          walletPubkey: input.walletPubkey,
          mode: shouldWrite ? "write" : "simulate",
          write: shouldWrite,
          writeRecord: shouldWrite,
          storeRecord: shouldWrite,
          cluster: config.cluster,
          connection: this.connection,
          signer: this.onchainSigner,
          programs: config.programs
        }
      ],
      [{ accessId: gatePk, user: walletPk, storeRecord: shouldWrite }],
      [{ gateId: gatePk, user: walletPk, storeRecord: shouldWrite }],
      [gateId, input.walletPubkey, { write: shouldWrite, cluster: config.cluster }],
      [input.walletPubkey, gateId, { write: shouldWrite, cluster: config.cluster }]
    ];

    const methodNames = shouldWrite
      ? ["checkAccess", "checkGate", "checkGateAccess", "check", "canAccess", "evaluateAccess"]
      : [
          "simulateCheckAccess",
          "simulateCheckGate",
          "checkAccess",
          "checkGate",
          "checkGateAccess",
          "check",
          "canAccess",
          "evaluateAccess"
        ];

    const raw = await this.withRpcTimeout("checkAccess", () =>
      this.invokeFirst(
        methodNames,
        argsVariants,
        "Access check failed"
      )
    );

    return normalizeResult(raw, source);
  }
}
