import { HunterEmailFinder, HunterEmailVerifier } from "./adapters/hunter.js";
import { MillionVerifier } from "./adapters/millionverifier.js";
import { ZeroBounce } from "./adapters/zerobounce.js";
import { NeverBounce } from "./adapters/neverbounce.js";
import { PeopleDataLabsFirmographics } from "./adapters/peopledatalabs.js";
import { RevenueBaseFirmographics } from "./adapters/revenuebase.js";
import { ExploriumFirmographics } from "./adapters/explorium.js";
import { CoresignalFirmographics } from "./adapters/coresignal.js";
import { DatagmaPhone } from "./adapters/datagma.js";
import { ContactOutPhone } from "./adapters/contactout.js";
import { CognismPhone } from "./adapters/cognism.js";
import {
  StubEmailFinder,
  StubEmailVerifier,
  StubFirmographics,
  StubPhoneProvider,
} from "./adapters/stub.js";
import type { CredentialSource, ProviderRegistry, WithCredential } from "./types.js";

/** Treat CDK placeholders and blank env as "no key" so we do not call live APIs with junk. */
export function isLiveApiKey(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  const v = value.trim().toLowerCase();
  return v !== "replace-me" && v !== "changeme" && v !== "placeholder";
}

export interface PalConfig {
  hunterApiKey?: string;
  millionVerifierApiKey?: string;
  zeroBounceApiKey?: string;
  neverBounceApiKey?: string;
  pdlApiKey?: string;
  revenueBaseApiKey?: string;
  exploriumApiKey?: string;
  coresignalApiKey?: string;
  datagmaApiKey?: string;
  contactOutApiKey?: string;
  cognismApiKey?: string;

  hunterBaseUrl?: string;
  millionVerifierBaseUrl?: string;
  zeroBounceBaseUrl?: string;
  neverBounceBaseUrl?: string;
  pdlBaseUrl?: string;
  revenueBaseBaseUrl?: string;
  exploriumBaseUrl?: string;
  coresignalBaseUrl?: string;
  datagmaBaseUrl?: string;
  contactOutBaseUrl?: string;
  cognismBaseUrl?: string;

  requestTimeoutMs?: number;
}

function withCredential<T extends { name: string }>(
  adapter: T,
  source: CredentialSource
): WithCredential<T> {
  return { ...adapter, credentialSource: source };
}

/** Build registry — workspace keys first, then platform keys, then stubs. */
export function createRegistryWithByok(
  platformCfg: PalConfig,
  workspaceCfg: Partial<PalConfig> = {}
): ProviderRegistry {
  const t = platformCfg.requestTimeoutMs ?? workspaceCfg.requestTimeoutMs;

  const emailFinders: ProviderRegistry["emailFinders"] = [];
  if (isLiveApiKey(workspaceCfg.hunterApiKey)) {
    emailFinders.push(
      withCredential(new HunterEmailFinder(workspaceCfg.hunterApiKey, platformCfg.hunterBaseUrl, t), "workspace")
    );
  }
  if (isLiveApiKey(platformCfg.hunterApiKey)) {
    emailFinders.push(
      withCredential(new HunterEmailFinder(platformCfg.hunterApiKey, platformCfg.hunterBaseUrl, t), "platform")
    );
  }
  if (emailFinders.length === 0) emailFinders.push(new StubEmailFinder());

  const emailVerifiers: ProviderRegistry["emailVerifiers"] = [];
  const addVerifier = (
    wsKey: string | undefined,
    platformKey: string | undefined,
    factory: (key: string) => ProviderRegistry["emailVerifiers"][number]
  ) => {
    if (isLiveApiKey(wsKey)) emailVerifiers.push(withCredential(factory(wsKey), "workspace"));
    if (isLiveApiKey(platformKey)) emailVerifiers.push(withCredential(factory(platformKey), "platform"));
  };

  addVerifier(
    workspaceCfg.millionVerifierApiKey,
    platformCfg.millionVerifierApiKey,
    (key) => new MillionVerifier(key, platformCfg.millionVerifierBaseUrl, t)
  );
  addVerifier(
    workspaceCfg.zeroBounceApiKey,
    platformCfg.zeroBounceApiKey,
    (key) => new ZeroBounce(key, platformCfg.zeroBounceBaseUrl, t)
  );
  addVerifier(
    workspaceCfg.neverBounceApiKey,
    platformCfg.neverBounceApiKey,
    (key) => new NeverBounce(key, platformCfg.neverBounceBaseUrl, t)
  );

  if (emailVerifiers.length === 0) {
    if (isLiveApiKey(workspaceCfg.hunterApiKey)) {
      emailVerifiers.push(
        withCredential(
          new HunterEmailVerifier(workspaceCfg.hunterApiKey, platformCfg.hunterBaseUrl, t),
          "workspace"
        )
      );
    }
    if (isLiveApiKey(platformCfg.hunterApiKey)) {
      emailVerifiers.push(
        withCredential(
          new HunterEmailVerifier(platformCfg.hunterApiKey, platformCfg.hunterBaseUrl, t),
          "platform"
        )
      );
    }
  }
  if (emailVerifiers.length === 0) emailVerifiers.push(new StubEmailVerifier());

  const firmographics: ProviderRegistry["firmographics"] = [];
  const addFirmographics = (
    wsKey: string | undefined,
    platformKey: string | undefined,
    factory: (key: string) => ProviderRegistry["firmographics"][number]
  ) => {
    if (isLiveApiKey(wsKey)) firmographics.push(withCredential(factory(wsKey), "workspace"));
    if (isLiveApiKey(platformKey)) firmographics.push(withCredential(factory(platformKey), "platform"));
  };

  addFirmographics(workspaceCfg.pdlApiKey, platformCfg.pdlApiKey, (key) =>
    new PeopleDataLabsFirmographics(key, platformCfg.pdlBaseUrl, t)
  );
  addFirmographics(workspaceCfg.revenueBaseApiKey, platformCfg.revenueBaseApiKey, (key) =>
    new RevenueBaseFirmographics(key, platformCfg.revenueBaseBaseUrl, t)
  );
  addFirmographics(workspaceCfg.exploriumApiKey, platformCfg.exploriumApiKey, (key) =>
    new ExploriumFirmographics(key, platformCfg.exploriumBaseUrl, t)
  );
  addFirmographics(workspaceCfg.coresignalApiKey, platformCfg.coresignalApiKey, (key) =>
    new CoresignalFirmographics(key, platformCfg.coresignalBaseUrl, t)
  );
  if (firmographics.length === 0) firmographics.push(new StubFirmographics());

  const phone: ProviderRegistry["phone"] = [];
  const addPhone = (
    wsKey: string | undefined,
    platformKey: string | undefined,
    factory: (key: string) => ProviderRegistry["phone"][number]
  ) => {
    if (isLiveApiKey(wsKey)) phone.push(withCredential(factory(wsKey), "workspace"));
    if (isLiveApiKey(platformKey)) phone.push(withCredential(factory(platformKey), "platform"));
  };

  addPhone(workspaceCfg.datagmaApiKey, platformCfg.datagmaApiKey, (key) =>
    new DatagmaPhone(key, platformCfg.datagmaBaseUrl, t)
  );
  addPhone(workspaceCfg.contactOutApiKey, platformCfg.contactOutApiKey, (key) =>
    new ContactOutPhone(key, platformCfg.contactOutBaseUrl, t)
  );
  addPhone(workspaceCfg.cognismApiKey, platformCfg.cognismApiKey, (key) =>
    new CognismPhone(key, platformCfg.cognismBaseUrl, t)
  );
  if (phone.length === 0) phone.push(new StubPhoneProvider());

  return { firmographics, emailFinders, emailVerifiers, phone };
}

/** Build registry — live adapters when keys present, stub fallback otherwise. */
export function createRegistryFromConfig(
  cfg: PalConfig,
  workspaceCfg?: Partial<PalConfig>
): ProviderRegistry {
  return createRegistryWithByok(cfg, workspaceCfg);
}

export function hasLiveProviders(cfg: PalConfig): boolean {
  return [
    cfg.hunterApiKey,
    cfg.millionVerifierApiKey,
    cfg.zeroBounceApiKey,
    cfg.neverBounceApiKey,
    cfg.pdlApiKey,
    cfg.revenueBaseApiKey,
    cfg.exploriumApiKey,
    cfg.coresignalApiKey,
    cfg.datagmaApiKey,
    cfg.contactOutApiKey,
    cfg.cognismApiKey,
  ].some(isLiveApiKey);
}
