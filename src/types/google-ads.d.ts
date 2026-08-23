// `google-ads` is an OPTIONAL dependency (installed only for production mode:
// `npm i google-ads`). This ambient declaration keeps the typecheck green without it.
declare module "google-ads" {
  export class GoogleAdsClient {
    constructor(cfg: {
      developerToken: string;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      customerId: string;
    });
    getGoogleAdsService(): { search(query: string): Promise<Record<string, unknown>[]> };
    getCampaignService(): { mutateCampaigns(customerId: string, mutations: unknown[]): Promise<Record<string, unknown>> };
    getCampaignBudgetService(): { mutateCampaignBudgets(customerId: string, mutations: unknown[]): Promise<Record<string, unknown>> };
    getCampaignNegativeCriterionService(): {
      mutateCampaignNegativeCriteria(customerId: string, mutations: unknown[]): Promise<Record<string, unknown>>;
    };
    getCriterionService(): { mutateCriteria(customerId: string, mutations: unknown[]): Promise<Record<string, unknown>> };
  }
}
