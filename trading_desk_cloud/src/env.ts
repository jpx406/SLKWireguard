export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  AGENT_ID: string;
  ENVIRONMENT_ID: string;
  LOGIN_PASSWORD?: string; // secret; when set, the app uses its own password login instead of Cloudflare Access
  ACCESS_TEAM_DOMAIN: string; // e.g. nesr.cloudflareaccess.com
  ACCESS_AUD: string; // Application Audience (AUD) tag from the Access application
  ANTHROPIC_BASE_URL?: string; // optional, e.g. a Cloudflare AI Gateway URL
  ANTHROPIC_WORKSPACE?: string; // workspace id for Console trace links; "default" if unset
  DEV_NO_AUTH?: string; // "1" only in .dev.vars for local `wrangler dev`
}
