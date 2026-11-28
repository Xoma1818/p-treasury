import {boot, done} from "./qa-finance-helpers.mjs";
import {groups,month} from "./qa-finance-budget.mjs";
import {scenarios,flow} from "./qa-finance-forecast.mjs";
import {reports} from "./qa-finance-reports.mjs";
import {homeActions} from "./qa-finance-home.mjs";
import {extras} from "./qa-finance-extra.mjs";

const selected = {groups,budget:month,forecast:scenarios,flow,reports,home:homeActions,extras}[process.argv[2]];
if (!selected) throw Error("Unknown workload");
try { await boot(); await selected(); } finally { await done(); }
