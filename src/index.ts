// hotleads — deep prospect research from any LinkedIn URL,
// and prospect search from your own company URL.
// Library entry. See https://github.com/ShapeStudio/hotleads

export { research, nameFromLinkedinUrl } from "./research.js";
export type { ResearchOptions, ResearchDepth } from "./research.js";
export { searchProspects } from "./search.js";
export type { SearchProspectsOptions } from "./search.js";
export { resolveLinkedinUrls } from "./linkedin-lookup.js";
export { sweepCompanyContacts, sweepToolSchema, SWEEP_MODEL } from "./contact-sweep.js";
export { findAlternateContacts, alternateLookupToolSchema, ALTERNATE_MAX_RESULTS } from "./alternate-lookup.js";
export type {
  AlternateLookupInput,
  AlternateLookupOptions,
  AlternateLookupResult,
  AlternateProspect,
} from "./alternate-lookup.js";
export { researchEmail } from "./email-lookup.js";
export type { EmailIdentity, EmailLookupOptions } from "./email-lookup.js";
export type { ContactSweepInput, ContactSweepOptions, ContactSweepResult } from "./contact-sweep.js";
export type { LookupPerson } from "./linkedin-lookup.js";
export { researchMany } from "./batch.js";
export type { BatchOptions, BatchResult } from "./batch.js";
export {
  prospectResearchSchema,
  researchToolSchema,
  researchInputSchema,
  prospectSearchSchema,
  prospectSearchToolSchema,
  prospectLeadSchema,
  searchInputSchema,
  assessReachability,
  SCHEMA_VERSION,
} from "./schema.js";
export type {
  ProspectResearch,
  ResearchInput,
  Person,
  Company,
  Competitor,
  Commercials,
  Outreach,
  ProspectSearch,
  SearchInput,
  IcpProfile,
  ProspectLead,
  ReachChannel,
  Reachability,
} from "./schema.js";
export type { ProgressEvent, OnProgress, CallUsage, OnUsage, EffortLevel } from "./anthropic.js";
export { DEFAULT_MODEL } from "./anthropic.js";
export { introduceCompany, INTRO_MODEL } from "./company-intro.js";
export { formatSellerProfile } from "./search.js";
export { plausibleProfileUrl } from "./profile-url.js";
export { sellerProfileSchema } from "./schema.js";
export type { SellerProfile } from "./schema.js";
export type { CompanyIntro, CompanyIntroOptions } from "./company-intro.js";
export { scoreLeads, rankKey, SCORER_VERSION } from "./lead-score.js";
export type { LeadScore, LeadScoreOptions } from "./lead-score.js";
export { noul, score, choice, typesafeConfigured, DEFAULT_JEV_MODEL } from "./typesafe.js";
export type { SystemOneCaller, TypeSafeOptions } from "./typesafe.js";
