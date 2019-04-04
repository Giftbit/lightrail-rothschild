import {Value} from "../../model/Value";
import {nowInDbPrecision} from "../../utils/dbUtils/index";
import * as crypto from "crypto";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {LightrailTransactionPlanStep, TransactionPlan} from "./transactions/TransactionPlan";
import {executeTransactionPlanner} from "./transactions/executeTransactionPlan";
import {getValue} from "./values";

export namespace GenericCodePerContact {
    export async function attach(auth: giftbitRoutes.jwtauth.AuthorizationBadge, contactId: string, genericValue: Value, simulate: boolean = false): Promise<Value> {
        let newAttachedValueId: string = null;

        const transactionPlanner = async (): Promise<TransactionPlan> => {
            const now = nowInDbPrecision();
            const steps: LightrailTransactionPlanStep[] = getAttachLightrailTransactionPlanSteps(auth, contactId, genericValue);
            // The new attached Value is created as a TransactionStep.
            newAttachedValueId = steps.find(step => step.value.id != genericValue.id).value.id;

            const transactionPlan: TransactionPlan = {
                id: newAttachedValueId,
                transactionType: "attach",
                currency: genericValue.currency,
                steps: [],
                totals: null,
                lineItems: null,
                paymentSources: null,
                createdDate: now,
                metadata: null,
                tax: null
            };
            transactionPlan.steps.push(...getAttachLightrailTransactionPlanSteps(auth, contactId, genericValue));
            return transactionPlan;
        };

        await executeTransactionPlanner(auth, {
            allowRemainder: false,
            simulate: false
        }, transactionPlanner);

        if (!newAttachedValueId) {
            throw new Error("This cannot happen. Something must have gone seriously wrong.")
        }

        return await getValue(auth, newAttachedValueId);
    }

    export function getAttachLightrailTransactionPlanSteps(auth: giftbitRoutes.jwtauth.AuthorizationBadge, contactId: string, genericValue: Value): LightrailTransactionPlanStep[] {
        const amount = genericValue.genericCodeProperties.valuePropertiesPerContact.balance;
        const uses = genericValue.genericCodeProperties.valuePropertiesPerContact.usesRemaining;
        const now = nowInDbPrecision();

        return [
            {
                // generic code
                rail: "lightrail",
                value: genericValue,
                amount: genericValue.balance !== null ? -amount : null,
                uses: genericValue.usesRemaining !== null ? -uses : null
            } as LightrailTransactionPlanStep,
            {
                rail: "lightrail",
                createValue: true,
                value: {
                    ...genericValue,
                    id: generateValueId(genericValue.id, contactId),
                    code: null,
                    isGenericCode: false,
                    contactId: contactId,
                    balance: amount != null ? amount : null,
                    usesRemaining: uses != null ? uses : null,
                    genericCodeProperties: null,
                    metadata: {
                        ...genericValue.metadata,
                        attachedFromGenericValue: {
                            code: genericValue.code
                        }
                    },
                    attachedFromGenericValueId: genericValue.id,
                    createdDate: now,
                    updatedDate: now,
                    updatedContactIdDate: now,
                    createdBy: auth.teamMemberId,
                },
                amount: amount,
                uses: uses,
            } as LightrailTransactionPlanStep
        ];
    }

    export function generateValueId(genericValueId: string, contactId: string) {
        return crypto.createHash("sha1").update(genericValueId + "/" + contactId).digest("base64").replace(/\//g, "-")
    }
}