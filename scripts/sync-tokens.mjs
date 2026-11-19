// The UI borrows Bandcloud's design tokens. This copies the generated CSS in;
// run it after a token change in Bandcloud and commit the result.
import { copyFileSync } from 'node:fs';

const source = process.env.TOKENS_CSS;
if (!source) {
  console.error('Sätt TOKENS_CSS till den genererade tokens.css, t.ex. TOKENS_CSS=~/Dev/<app>/packages/tokens/dist/tokens.css npm run tokens:sync');
  process.exit(1);
}
copyFileSync(source, new URL('../web/src/tokens.css', import.meta.url));
console.log(`Kopierade ${source}`);
