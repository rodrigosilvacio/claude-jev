// Copia a lógica compartilhada (public/js) para a Edge Function do Supabase.
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
for (const f of ['core.js', 'jev.js']) {
  fs.copyFileSync(path.join(raiz, 'public/js', f), path.join(raiz, 'supabase/functions/jev-decisao', f));
  console.log('sincronizado:', f);
}
