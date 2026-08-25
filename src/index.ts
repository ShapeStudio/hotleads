// landermixer — deep prospect research from any LinkedIn URL,
// and prospect search from your own company URL.
// Library entry. See https://github.com/ShapeStudio/landermixer

export { research, nameFromLinkedinUrl } from "./research.js";
export type { ResearchOptions, ResearchDepth } from "./research.js";
export { searchProspects } from "./search.js";
export type { SearchProspectsOptions } from "./search.js";
export { resolveLinkedinUrls } from "./linkedin-lookup.js";
export { sweepCompanyContacts, SWEEP_MODEL } from "./contact-sweep.js";
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
} from "./schema.js";
export type { ProgressEvent, OnProgress } from "./anthropic.js";
export { DEFAULT_MODEL } from "./anthropic.js";
