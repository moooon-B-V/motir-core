// The type of this catalogue, so the checker never parses its JSON (MOTIR-8405).
// It has the English catalogue's shape; `tsconfig.base.json` explains why.
declare const catalogue: typeof import('./en.json');
export default catalogue;
