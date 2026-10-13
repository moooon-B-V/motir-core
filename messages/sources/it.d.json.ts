// The type of this source record, so the checker never parses its JSON
// (MOTIR-8405): dotted key -> the English it was translated from.
// `tsconfig.base.json` explains why.
declare const sources: Record<string, string>;
export default sources;
