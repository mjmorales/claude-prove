import { Logger } from './logger';
import { add } from './math';

export function main(): number {
  const log = new Logger();
  log.info('start');
  return add(1, 2);
}
