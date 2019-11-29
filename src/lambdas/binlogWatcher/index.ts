import * as awslambda from "aws-lambda";
import * as logPrefix from "loglevel-plugin-prefix";
import {getDbCredentials} from "../../utils/dbUtils/connection";
import {BinlogStream} from "./binlogStream/BinlogStream";
import {BinlogTransactionBuilder} from "./binlogTransaction/BinlogTransactionBuilder";
import {getLightrailMessages} from "./getLightrailMessages/getLightrailMessages";
import {BinlogWatcherStateManager} from "./BinlogWatcherStateManager";
import {LightrailMessagePublisher} from "../LightrailMessagePublisher";
import log = require("loglevel");

// Wrapping console.log instead of binding (default behaviour for loglevel)
// Otherwise all log calls are prefixed with the requestId from the first
// request the lambda received (AWS modifies log calls, loglevel binds to the
// version of console.log that exists when it is initialized).
// See https://github.com/pimterry/loglevel/blob/master/lib/loglevel.js
// tslint:disable-next-line:no-console
log.methodFactory = () => (...args) => console.log(...args);

// Prefix log messages with the level.
logPrefix.reg(log);
logPrefix.apply(log, {
    format: (level, name, timestamp) => {
        return `[${level}]`;
    }
});

log.setLevel(process.env.LOG_LEVEL as any || log.levels.INFO);

export async function handler(evt: awslambda.CloudFormationCustomResourceEvent, ctx: awslambda.Context): Promise<any> {

}

export async function createMySqlEventsInstance(): Promise<BinlogStream> {
    // TODO Don't use master credentials.  Create a readrep user and use those credentials.
    // They can be passed in using the usual env vars though so this code is fine.
    const dbCredentials = await getDbCredentials();

    const binlogStream = new BinlogStream({
        host: process.env["DB_ENDPOINT"],
        user: dbCredentials.username,
        password: dbCredentials.password,
        port: +process.env["DB_PORT"],
        timezone: "Z"
    });


    const txBuilder = new BinlogTransactionBuilder();
    binlogStream.on("binlog", event => txBuilder.handleBinlogEvent(event));

    const publisher = new LightrailMessagePublisher();
    txBuilder.on("transaction", async tx => {
        try {
            const msgs = await getLightrailMessages(tx);
            await publisher.publishAll(msgs);
        } catch (err) {
            log.error("Error getting LightrailMessages", err);
        }
    });

    const binlogWatcherStateManager = new BinlogWatcherStateManager();
    binlogStream.on("binlog", event => binlogWatcherStateManager.onBinlogEvent(event));
    txBuilder.on("transaction", tx => binlogWatcherStateManager.onTransaction(tx));
    txBuilder.on("transactionStart", () => binlogWatcherStateManager.pauseCheckpointing());
    txBuilder.on("transactionEnd", () => binlogWatcherStateManager.unpauseCheckpointing());
    publisher.on("failing", () => binlogWatcherStateManager.pauseCheckpointing());
    publisher.on("ok", () => binlogWatcherStateManager.unpauseCheckpointing());

    await binlogStream.start({
        serverId: 1234,
        filename: "bin.000025",
        position: 0,
        excludeSchema: {
            mysql: true,
        }
    });

    return binlogStream;
}
