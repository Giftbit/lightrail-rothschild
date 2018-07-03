import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as jsonschema from "jsonschema";
import {Pagination, PaginationParams} from "../../model/Pagination";
import {DbProgram, Program} from "../../model/Program";
import {csvSerializer} from "../../serializers";
import {pick, pickOrDefault} from "../../utils/pick";
import {nowInDbPrecision} from "../../utils/dbUtils";
import {getKnexRead, getKnexWrite} from "../../utils/dbUtils/connection";
import {paginateQuery} from "../../utils/dbUtils/paginateQuery";

export function installValueTemplatesRest(router: cassava.Router): void {
    router.route("/v2/programs")
        .method("GET")
        .serializers({
            "application/json": cassava.serializers.jsonSerializer,
            "text/csv": csvSerializer
        })
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            const res = await getPrograms(auth, Pagination.getPaginationParams(evt));
            return {
                headers: Pagination.toHeaders(evt, res.pagination),
                body: res.programs
            };
        });

    router.route("/v2/programs")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            evt.validateBody(programSchema);

            const now = nowInDbPrecision();
            const program: Program = {
                ...pickOrDefault(evt.body,
                    {
                        id: "",
                        name: "",
                        currency: "",
                        discount: true,
                        pretax: true,
                        active: true,
                        redemptionRule: null,
                        valueRule: null,
                        minInitialBalance: null,
                        maxInitialBalance: null,
                        fixedInitialBalances: null,
                        fixedInitialUses: null,
                        startDate: null,
                        endDate: null,
                        metadata: null
                    }
                ),
                createdDate: now,
                updatedDate: now
            };

            return {
                statusCode: cassava.httpStatusCode.success.CREATED,
                body: await createProgram(auth, program)
            };
        });

    router.route("/v2/programs/{id}")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            return {
                body: await getProgram(auth, evt.pathParameters.id)
            };
        });

    router.route("/v2/programs/{id}")
        .method("PATCH")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            evt.validateBody(programSchema);

            const now = nowInDbPrecision();
            const program: Partial<Program> = {
                ...pick(evt.body as Program, "discount", "pretax", "active", "redemptionRule", "valueRule", "minInitialBalance", "maxInitialBalance", "fixedInitialBalances", "fixedInitialUses", "startDate", "endDate", "metadata"),
                updatedDate: now
            };

            return {
                body: await updateProgram(auth, evt.pathParameters.id, program)
            };
        });

    router.route("/v2/programs/{id}")
        .method("DELETE")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            return {
                body: await deleteProgram(auth, evt.pathParameters.id)
            };
        });

}

async function getPrograms(auth: giftbitRoutes.jwtauth.AuthorizationBadge, pagination: PaginationParams): Promise<{ programs: Program[], pagination: Pagination }> {
    auth.requireIds("giftbitUserId");

    const knex = await getKnexRead();
    const res = await paginateQuery<DbProgram>(
        knex("Programs")
            .where({
                userId: auth.giftbitUserId
            }),
        pagination
    );

    return {
        programs: res.body.map(DbProgram.toProgram),
        pagination: res.pagination
    };
}

async function createProgram(auth: giftbitRoutes.jwtauth.AuthorizationBadge, program: Program): Promise<Program> {
    auth.requireIds("giftbitUserId");

    try {
        const knex = await getKnexWrite();
        await knex("Programs")
            .insert(Program.toDbProgram(auth, program));
        return program;
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            throw new cassava.RestError(cassava.httpStatusCode.clientError.CONFLICT, `ValueTemplate with valueTemplateId '${program.id}' already exists.`);
        }
        throw err;
    }
}

async function getProgram(auth: giftbitRoutes.jwtauth.AuthorizationBadge, id: string): Promise<Program> {
    auth.requireIds("giftbitUserId");

    const knex = await getKnexRead();
    const res: DbProgram[] = await knex("Programs")
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
    return DbProgram.toProgram(res[0]);
}

async function updateProgram(auth: giftbitRoutes.jwtauth.AuthorizationBadge, id: string, program: Partial<Program>): Promise<Program> {
    auth.requireIds("giftbitUserId");

    const knex = await getKnexWrite();
    const res = await knex("Programs")
        .where({
            userId: auth.giftbitUserId,
            id: id
        })
        .update(program);
    if (res[0] === 0) {
        throw new cassava.RestError(404);
    }
    if (res[0] > 1) {
        throw new Error(`Illegal UPDATE query.  Updated ${res.length} values.`);
    }
    return {
        ...await getProgram(auth, id),
        ...program
    };
}


async function deleteProgram(auth: giftbitRoutes.jwtauth.AuthorizationBadge, id: string): Promise<{ success: true }> {
    auth.requireIds("giftbitUserId");

    const knex = await getKnexWrite();
    const res = await knex("Programs")
        .where({
            userId: auth.giftbitUserId,
            id: id
        })
        .delete();
    if (res[0] === 0) {
        throw new cassava.RestError(404);
    }
    if (res[0] > 1) {
        throw new Error(`Illegal DELETE query.  Deleted ${res.length} values.`);
    }
    return {success: true};
}

const programSchema: jsonschema.Schema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: {
            type: "string",
            maxLength: 32,
            minLength: 1
        },
        name: {
            type: "string",
            maxLength: 65535,
            minLength: 1
        },
        currency: {
            type: "string",
            minLength: 1,
            maxLength: 16
        },
        discount: {
            type: "boolean"
        },
        pretax: {
            type: "boolean"
        },
        active: {
            type: "boolean"
        },
        redemptionRule: {
            oneOf: [ // todo can we export this schema for a rule so that it's not duplicated?
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
        minInitialBalance: {
            type: ["string", "null"],
            minimum: 0
        },
        maxInitialBalance: {
            type: ["string", "null"],
            minimum: 0
        },
        fixedInitialBalances: {
            type: ["array", "null"],
            items: {
                type: "number",
                minimum: 0
            }
        },
        fixedInitialUses: {
            type: ["array", "null"],
            items: {
                type: "number",
                minimum: 1
            }
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
    required: ["id", "name", "currency"]
};
