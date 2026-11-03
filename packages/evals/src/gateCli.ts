import {readFileSync} from 'node:fs';
import {gate,type Report} from './gate.js';
/** Compare two metadata reports. Does not load prompts or invoke models. Exit 0 pass, 1 fail, 2 usage/input error. */
const [baseline,candidate,...extra]=process.argv.slice(2);
if(!baseline||!candidate||extra.length){
  console.error('usage: gateCli.ts <baseline-report.json> <candidate-report.json>');
  process.exit(2);
}
let reports:[Report,Report];
try {
  reports=[JSON.parse(readFileSync(baseline,'utf8')) as Report,JSON.parse(readFileSync(candidate,'utf8')) as Report];
} catch(error) {
  console.error(`cannot read report: ${error instanceof Error?error.message:String(error)}`);
  process.exit(2);
}
const result=gate(...reports);
console.log(JSON.stringify(result));
process.exitCode=result.pass?0:1;
