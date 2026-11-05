// Configuração pública do app (seguro versionar: URL e chave anon do Supabase são públicas por design).
// A chave do jev NÃO fica aqui: ela mora nos secrets da Edge Function.
window.JEV_APP_CONFIG = {
  supabaseFunctionUrl: 'https://xtrvojnauvkkterogrst.supabase.co/functions/v1/jev-decisao',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0cnZvam5hdXZra3Rlcm9ncnN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMDM0MzIsImV4cCI6MjA5ODc3OTQzMn0.FpsKiux4AA7id9CVgVQNysQCGGQspoTJYEL_EJ5ddmg',
  // Modelos oferecidos na tela. O jev é o padrão. A Edge Function só aceita os da lista JEV_MODELOS.
  modelos: ['typesafe/jev-1.13'],
  // Modelos Claude oferecidos (a Edge Function só aceita os da lista CLAUDE_MODELOS).
  modelosClaude: ['claude-opus-5-5'],
  endpointDireto: 'https://api.defapi.org/v1/chat/completions',
};
