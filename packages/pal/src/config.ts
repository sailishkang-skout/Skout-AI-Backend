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
import type { ProviderRegistry } from "./types.js";

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

/** Build registry — live adapters when keys present, stub fallback otherwise. */
export function createRegistryFromConfig(cfg: PalConfig): ProviderRegistry {
  const t = cfg.requestTimeoutMs;

  const emailFinders = cfg.hunterApiKey
    ? [new HunterEmailFinder(cfg.hunterApiKey, cfg.hunterBaseUrl, t)]
    : [new StubEmailFinder()];

  const emailVerifiers: ProviderRegistry["emailVerifiers"] = [];
  if (cfg.millionVerifierApiKey)
    emailVerifiers.push(new MillionVerifier(cfg.millionVerifierApiKey, cfg.millionVerifierBaseUrl, t));
  if (cfg.zeroBounceApiKey)
    emailVerifiers.push(new ZeroBounce(cfg.zeroBounceApiKey, cfg.zeroBounceBaseUrl, t));
  if (cfg.neverBounceApiKey)
    emailVerifiers.push(new NeverBounce(cfg.neverBounceApiKey, cfg.neverBounceBaseUrl, t));
  if (cfg.hunterApiKey && emailVerifiers.length === 0) {
    emailVerifiers.push(new HunterEmailVerifier(cfg.hunterApiKey, cfg.hunterBaseUrl, t));
  }
  if (emailVerifiers.length === 0) emailVerifiers.push(new StubEmailVerifier());

  // Firmographics waterfall (strategy §8): PDL → RevenueBase → Explorium → Coresignal
  const firmographics: ProviderRegistry["firmographics"] = [];
  if (cfg.pdlApiKey) firmographics.push(new PeopleDataLabsFirmographics(cfg.pdlApiKey, cfg.pdlBaseUrl, t));
  if (cfg.revenueBaseApiKey)
    firmographics.push(new RevenueBaseFirmographics(cfg.revenueBaseApiKey, cfg.revenueBaseBaseUrl, t));
  if (cfg.exploriumApiKey)
    firmographics.push(new ExploriumFirmographics(cfg.exploriumApiKey, cfg.exploriumBaseUrl, t));
  if (cfg.coresignalApiKey)
    firmographics.push(new CoresignalFirmographics(cfg.coresignalApiKey, cfg.coresignalBaseUrl, t));
  if (firmographics.length === 0) firmographics.push(new StubFirmographics());

  // Phone waterfall (strategy §6): Datagma → ContactOut → Cognism (EMEA)
  const phone: ProviderRegistry["phone"] = [];
  if (cfg.datagmaApiKey) phone.push(new DatagmaPhone(cfg.datagmaApiKey, cfg.datagmaBaseUrl, t));
  if (cfg.contactOutApiKey)
    phone.push(new ContactOutPhone(cfg.contactOutApiKey, cfg.contactOutBaseUrl, t));
  if (cfg.cognismApiKey) phone.push(new CognismPhone(cfg.cognismApiKey, cfg.cognismBaseUrl, t));
  if (phone.length === 0) phone.push(new StubPhoneProvider());

  return { firmographics, emailFinders, emailVerifiers, phone };
}

export function hasLiveProviders(cfg: PalConfig): boolean {
  return Boolean(
    cfg.hunterApiKey ||
      cfg.millionVerifierApiKey ||
      cfg.zeroBounceApiKey ||
      cfg.neverBounceApiKey ||
      cfg.pdlApiKey ||
      cfg.revenueBaseApiKey ||
      cfg.exploriumApiKey ||
      cfg.coresignalApiKey ||
      cfg.datagmaApiKey ||
      cfg.contactOutApiKey ||
      cfg.cognismApiKey
  );
}
