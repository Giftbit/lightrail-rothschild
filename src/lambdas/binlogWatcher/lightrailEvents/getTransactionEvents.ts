import {LightrailEvent} from "./LightrailEvent";
import {
    DbTransaction,
    InternalDbTransactionStep,
    LightrailDbTransactionStep,
    StripeDbTransactionStep
} from "../../../model/Transaction";
import {BinlogTransaction} from "../binlogTransaction/BinlogTransaction";

export async function getTransactionCreatedEvents(tx: BinlogTransaction): Promise<LightrailEvent[]> {
    return tx.statements
        .filter(s => s.type === "INSERT" && s.table === "Transactions")
        .reduce((res, s) => [...res, ...s.affectedRows], [] as BinlogTransaction.AffectedRow<DbTransaction>[])
        .map(row => {
            const dbTransaction = row.after as DbTransaction;

            const dbLightrailTransactionSteps = tx.statements
                .filter(s => s.type === "INSERT" && s.table === "LightrailTransactionSteps")
                .reduce((res, s) => [...res, ...s.affectedRows], [] as BinlogTransaction.AffectedRow<LightrailDbTransactionStep>[])
                .filter(row => row.after.userId === dbTransaction.userId && row.after.transactionId === dbTransaction.id)
                .map(row => row.after);
            const dbStripeTransactionSteps = tx.statements
                .filter(s => s.type === "INSERT" && s.table === "StripeTransactionSteps")
                .reduce((res, s) => [...res, ...s.affectedRows], [] as BinlogTransaction.AffectedRow<StripeDbTransactionStep>[])
                .filter(row => row.after.userId === dbTransaction.userId && row.after.transactionId === dbTransaction.id)
                .map(row => row.after);
            const dbInternalTransactionSteps = tx.statements
                .filter(s => s.type === "INSERT" && s.table === "InternalTransactionSteps")
                .reduce((res, s) => [...res, ...s.affectedRows], [] as BinlogTransaction.AffectedRow<InternalDbTransactionStep>[])
                .filter(row => row.after.userId === dbTransaction.userId && row.after.transactionId === dbTransaction.id)
                .map(row => row.after);

            return {
                specversion: "1.0",
                type: "lightrail.transaction.created",
                source: "/lightrail/rothschild",
                id: `tx-created-${dbTransaction.id}`,
                time: dbTransaction.createdDate,
                userId: dbTransaction.userId,
                datacontenttype: "application/json",
                data: {
                    newTransaction: DbTransaction.toTransaction(dbTransaction, [...dbLightrailTransactionSteps, ...dbStripeTransactionSteps, ...dbInternalTransactionSteps])
                }
            };
        });
}
