import { parse } from 'dotenv'

/**
 * Parse a dotenv-compatible KEY=value multi-line string into a Record.
 * (v0.3.2 自 CS_V1 移植)
 */
export const parseKeyValueString = (str: string): Record<string, string> => {
  return parse(str)
}
