import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as jsonschema from "jsonschema";
import {Pagination, PaginationParams} from "../../model/Pagination";
import {getKnexWrite, getKnexRead, getSqlErrorConstraintName, nowInDbPrecision} from "../../dbUtils";
import {DbValue, Value} from "../../model/Value";
import {pick, pickOrDefault} from "../../pick";
import {csvSerializer} from "../../serializers";
import {Contact} from "../../model/Contact";
import {updateContact} from "./contacts";

export function installValuesRest(router: cassava.Router): void {
    router.route("/v2/values")
        .method("GET")
        .serializers({
            "application/json": cassava.serializers.jsonSerializer,
            "text/csv": csvSerializer
        })
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            const res = await getValues(auth, Pagination.getPaginationParams(evt));
            return {
                headers: Pagination.toHeaders(res.pagination),
                body: res.values
            };
        });

    router.route("/v2/values")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            evt.validateBody(valueSchema);

            const now = nowInDbPrecision();
            const value: Value = {
                ...pickOrDefault(evt.body, {
                    id: "",
                    currency: "",
                    balance: 0,
                    uses: null,
                    programId: null,
                    code: null,
                    contactId: null,
                    pretax: false,
                    active: true,
                    frozen: false,
                    redemptionRule: null,
                    valueRule: null,
                    startDate: null,
                    endDate: null,
                    metadata: null
                }),
                canceled: false,
                createdDate: now,
                updatedDate: now
            };
            return {
                statusCode: cassava.httpStatusCode.success.CREATED,
                body: await createValue(auth, value)
            };
        });

    router.route("/v2/values")
        .method("PATCH")
        .handler(async evt => {
            throw new giftbitRoutes.GiftbitRestError(500, "Not implemented");   // TODO
        });

    router.route("/v2/values/{id}")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");

            return {
                body: await getValue(auth, evt.pathParameters.id)
            };
        });

    router.route("/v2/values/{id}")
        .method("PATCH")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            evt.validateBody(valueUpdateSchema);

            if (evt.body.id && evt.body.id !== evt.pathParameters.id) {
                throw new giftbitRoutes.GiftbitRestError(422, `The body id '${evt.body.id}' does not match the path id '${evt.pathParameters.id}'.  The id cannot be updated.`);
            }

            const now = nowInDbPrecision();
            const value = {
                ...pick<Value>(evt.body, "contactId", "pretax", "active", "canceled", "frozen", "pretax", "redemptionRule", "valueRule", "startDate", "endDate", "metadata"),
                updatedDate: now
            };
            return {
                body: await updateValue(auth, evt.pathParameters.id, value)
            };
        });

    router.route("/v2/values/{id}")
        .method("DELETE")
        .handler(async evt => {
            throw new giftbitRoutes.GiftbitRestError(500, "Not implemented");   // TODO
        });

    router.route("/v2/values/{id}/changeCode")
        .method("POST")
        .handler(async evt => {
            throw new giftbitRoutes.GiftbitRestError(500, "Not implemented");   // TODO
        });
}

export async function getValues(auth: giftbitRoutes.jwtauth.AuthorizationBadge, pagination: PaginationParams): Promise<{values: Value[], pagination: Pagination}> {
    auth.requireIds("giftbitUserId");

    const knex = await getKnexRead();
    const res: DbValue[] = await knex("Values")
        .where({
            userId: auth.giftbitUserId
        })
        .select()
        .orderBy("id")
        .limit(pagination.limit)
        .offset(pagination.offset);
    return {
        values: res.map(DbValue.toValue),
        pagination: {
            limit: pagination.limit,
            maxLimit: pagination.maxLimit,
            offset: pagination.offset
        }
    };
}

async function createValue(auth: giftbitRoutes.jwtauth.AuthorizationBadge, value: Value): Promise<Value> {
    auth.requireIds("giftbitUserId");

    try {
        const knex = await getKnexWrite();
        await knex("Values")
            .insert(Value.toDbValue(auth, value));
        return value;
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `Values with id '${value.id}' already exists.`);
        }
        if (err.code === "ER_NO_REFERENCED_ROW_2") {
            const constraint = getSqlErrorConstraintName(err);
            if (constraint === "fk_Values_Currencies") {
                throw new giftbitRoutes.GiftbitRestError(cassava.httpStatusCode.clientError.CONFLICT, `Currency '${value.currency}' does not exist.  See the documentation on creating currencies.`, "CurrencyNotFound");
            }
        }
        throw err;
    }
}

async function getValue(auth: giftbitRoutes.jwtauth.AuthorizationBadge, id: string): Promise<Value> {
    auth.requireIds("giftbitUserId");

    const knex = await getKnexRead();
    const res: DbValue[] = await knex("Values")
        .select()
        .where({
            userId: auth.giftbitUserId,
            id: id
        });
    if (res.length === 0) {
        throw new cassava.RestError(404);
    }
    if (res.length > 1) {
        throw new Error(`Illegal SELECT query.  Returned ${res.length} values.`);
    }
    return DbValue.toValue(res[0]);
}

async function updateValue(auth: giftbitRoutes.jwtauth.AuthorizationBadge, id: string, value: Partial<Value>): Promise<Value> {
    auth.requireIds("giftbitUserId");

    const knex = await getKnexWrite();
    const res = await knex("Values")
        .where({
            userId: auth.giftbitUserId,
            id: id
        })
        .update(Value.toDbValueUpdate(auth, value));
    if (res[0] === 0) {
        throw new cassava.RestError(404);
    }
    if (res[0] > 1) {
        throw new Error(`Illegal UPDATE query.  Updated ${res.length} values.`);
    }
    return {
        ...await getValue(auth, id),
        ...value
    };
}

const valueSchema: jsonschema.Schema = {
    type: "object",
    properties: {
        id: {
            type: "string",
            maxLength: 64,
            minLength: 1
        },
        currency: {
            type: "string",
            minLength: 1,
            maxLength: 16
        },
        balance: {
            type: ["number", "null"]
        },
        uses: {
            type: ["number", "null"]
        },
        programId: {
            type: ["string", "null"],
            maxLength: 64,
            minLength: 1
        },
        code: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 255
        },
        contactId: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 64
        },
        active: {
            type: "boolean"
        },
        frozen: {
            type: "boolean"
        },
        pretax: {
            type: "boolean"
        },
        redemptionRule: {
            oneOf: [
                {
                    type: "null"
                },
                {
                    title: "Redemption rule",
                    type: "object",
                    properties: {
                        rule: {
                            type: "string"
                        },
                        explanation: {
                            type: "string"
                        }
                    }
                }
            ]
        },
        valueRule: {
            oneOf: [
                {
                    type: "null"
                },
                {
                    title: "Value rule",
                    type: "object",
                    properties: {
                        rule: {
                            type: "string"
                        },
                        explanation: {
                            type: "string"
                        }
                    }
                }
            ]
        },
        startDate: {
            type: ["string", "null"],
            format: "date-time"
        },
        endDate: {
            type: ["string", "null"],
            format: "date-time"
        },
        metadata: {
            type: ["object", "null"]
        }
    },
    required: ["id", "currency"]
};

const valueUpdateSchema: jsonschema.Schema = {
    type: "object",
    properties: {
        id: {
            type: "string",
            maxLength: 64,
            minLength: 1
        },
        contactId: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 64
        },
        active: {
            type: "boolean"
        },
        canceled: {
            type: "boolean",
            enum: [true]
        },
        frozen: {
            type: "boolean"
        },
        pretax: {
            type: "boolean"
        },
        redemptionRule: {
            oneOf: [
                {
                    type: "null"
                },
                {
                    title: "Redemption rule",
                    type: "object",
                    properties: {
                        rule: {
                            type: "string"
                        },
                        explanation: {
                            type: "string"
                        }
                    }
                }
            ]
        },
        valueRule: {
            oneOf: [
                {
                    type: "null"
                },
                {
                    title: "Value rule",
                    type: "object",
                    properties: {
                        rule: {
                            type: "string"
                        },
                        explanation: {
                            type: "string"
                        }
                    }
                }
            ]
        },
        startDate: {
            type: ["string", "null"],
            format: "date-time"
        },
        endDate: {
            type: ["string", "null"],
            format: "date-time"
        },
        metadata: {
            type: ["object", "null"]
        }
    },
    required: []
};
