// Public settings. The publishable key grants no table access (RLS is locked);
// everything goes through the karman function, which checks the signed-in user.
window.KL = {
  supabaseUrl: "https://nouuodihcgddrdyfkoca.supabase.co",
  publishableKey: "sb_publishable__a7e4Oa-GPwnSQzPIeihOw_kd-UD25v",
  api: "https://nouuodihcgddrdyfkoca.supabase.co/functions/v1/karman",
  base: "/KarmanLang/",          // GitHub Pages project path; "/" on a custom domain
  providers: ["email"],          // add "google", "azure" once enabled in Supabase Auth
};
