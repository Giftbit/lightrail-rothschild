import * as jsonschema from "jsonschema";
import * as knex from "knex";
import * as giftbitRoutes from "giftbit-cassava-routes";
import {Pagination, PaginationParams} from "../../model/Pagination";
import {QueryOptions} from "./QueryOptions";

/**
 * The state necessary to fetch the next page in pagination.
 */
interface PaginationCursor {
    /**
     * The `id` value of the last (first) item on the page that will define
     * what goes on the next (previous) page.
     */
    id: string;

    /**
     * The sort field value of the last (first) item on the page that will define
     * what goes on the next (previous) page.
     */
    sort?: string | number;
}

namespace PaginationCursor {
    export function build(before: boolean, resBody: any[], paginationParams: PaginationParams): PaginationCursor {
        const ix = before ? 0 : resBody.length - 1;
        const cursor: PaginationCursor = {
            id: resBody[ix].id
        };
        if (paginationParams.sort) {
            cursor.sort = resBody[ix][paginationParams.sort.field];
        }
        return cursor;
    }

    export function decode(s: string): PaginationCursor {
        try {
            const cursor: PaginationCursor = JSON.parse(Buffer.from(s.replace(/_/g, "="), "base64").toString());

            // Catch tampering that could create silly 500s.
            const validation = jsonschema.validate(cursor, {
                properties: {
                    id: {
                        type: "string",
                        minLength: 1
                    },
                    sort: {
                        type: ["string", "number"],
                        minLength: 1
                    }
                },
                required: ["id"],
                additionalProperties: false
            });
            if (validation.errors.length) {
                throw new Error();
            }
            return cursor;
        } catch (unused) {
            throw new giftbitRoutes.GiftbitRestError(400);
        }
    }

    export function encode(c: PaginationCursor): string {
        return Buffer.from(JSON.stringify(c)).toString("base64").replace(/=/g, "_");
    }
}

/**
 * Apply cursor-based pagination to the given query.  All filtering is supported but sorting (ORDER BY)
 * must be done through PaginationParams and not be part of the query.
 */
export async function paginateQuery<T extends { id: string }>(query: knex.QueryBuilder, paginationParams: PaginationParams, options: QueryOptions = null): Promise<{ body: T[], pagination: Pagination }> {
    if (paginationParams.limit > paginationParams.maxLimit) {
        throw new Error(`limit ${paginationParams.limit} > maxLimit ${paginationParams.maxLimit}, this should already be sanitized`);
    }
    if (paginationParams.limit < 1) {
        throw new Error(`limit ${paginationParams.limit} < 1, this should already be sanitized`);
    }

    let reverse = false;
    let atFirst = false;
    let atLast = false;

    let columnPrefix = ""; // If a tableName is provided will prefix column with "tableName."
    if (options && options.tableName) {
        columnPrefix = options.tableName + ".";
    }

    // On Pagination
    //
    // The first thing you need to know is that the naive/easy thing of using
    // OFFSET (shorthand LIMIT N, M) is terrible.  You pay the full cost of
    // processing all the rows you skipped.  Each page fetched is more expensive
    // than the one before. Similarly COUNTing the number of results pays the full
    // price of processing every result which is why we don't do that either.
    //
    // What we do instead is cursor pagination.  The next page is defined by values
    // that come after the last item in the previous page.  With one unique sort field (id)
    // that's easy.  When sorting on multiple fields (createdDate, id) the next page of
    // results might have createdDates that equal the end of the previous page.
    // How do we get the next page in that case?
    //
    // The SQL spec technically has a feature called row value constructors.  The
    // syntax can be used in a WHERE clause like `(createdDate, id) < (?, ?)`.  Note
    // this is the same syntax you see in INSERT or WHERE IN.  MySQL technically supports
    // this but won't use it to access the index (sad).
    //
    // The most obvious thing to do is `WHERE (createdDate < ?) or (createdDate = ? AND id < ?)`.
    // Unfortunately the DB won't see that the two halves have createdDate in common and
    // share work between them.  So it duplicates effort.
    //
    // The most efficient paging query looks like this `WHERE createdDate <= ? AND NOT
    // (createdDate = ? AND id >= ?)`.  ie: include all the results that tie on createdDate
    // from the previous page and then filter them out.

    if (paginationParams.after) {
        const after = PaginationCursor.decode(paginationParams.after);
        if (after.sort != null && paginationParams.sort) {
            query = query
                .where(columnPrefix + paginationParams.sort.field, paginationParams.sort.asc ? ">=" : "<=", after.sort)
                .whereNot(query => query
                    .where(columnPrefix + paginationParams.sort.field, "=", after.sort)
                    .where(columnPrefix + "id", paginationParams.sort.asc ? "<=" : ">=", after.id)
                )
                .orderBy(columnPrefix + paginationParams.sort.field, paginationParams.sort.asc ? "ASC" : "DESC")
                .orderBy(columnPrefix + "id", paginationParams.sort.asc ? "ASC" : "DESC");
        } else {
            query = query
                .where(columnPrefix + "id", ">", after.id)
                .orderBy(columnPrefix + "id", "ASC");
        }
    } else if (paginationParams.before) {
        const before = PaginationCursor.decode(paginationParams.before);
        if (before.sort != null && paginationParams.sort) {
            query = query
                .where(columnPrefix + paginationParams.sort.field, paginationParams.sort.asc ? "<=" : ">=", before.sort)
                .whereNot(query => query
                    .where(columnPrefix + paginationParams.sort.field, "=", before.sort)
                    .where(columnPrefix + "id", paginationParams.sort.asc ? ">=" : "<=", before.id)
                )
                .orderBy(columnPrefix + paginationParams.sort.field, paginationParams.sort.asc ? "DESC" : "ASC")
                .orderBy(columnPrefix + "id", paginationParams.sort.asc ? "DESC" : "ASC");
        } else {
            query = query
                .where(columnPrefix + "id", "<", before.id)
                .orderBy(columnPrefix + "id", "DESC");
        }
        reverse = true;
    } else if (paginationParams.last) {
        if (paginationParams.sort) {
            query = query
                .orderBy(columnPrefix + paginationParams.sort.field, paginationParams.sort.asc ? "DESC" : "ASC")
                .orderBy(columnPrefix + "id", paginationParams.sort.asc ? "DESC" : "ASC");
        } else {
            query = query
                .orderBy(columnPrefix + "id", "DESC");
        }
        reverse = true;
        atLast = true;
    } else {
        if (paginationParams.sort) {
            query = query
                .orderBy(columnPrefix + paginationParams.sort.field, paginationParams.sort.asc ? "ASC" : "DESC")
                .orderBy(columnPrefix + "id", paginationParams.sort.asc ? "ASC" : "DESC");
        } else {
            query = query
                .orderBy(columnPrefix + "id", "ASC");
        }
        atFirst = true;
    }

    query = query.limit(paginationParams.limit);

    const resBody: T[] = await query;
    if (reverse) {
        resBody.reverse();
    }
    if (resBody.length < paginationParams.limit) {
        if (paginationParams.after) {
            atLast = true;
        } else if (paginationParams.before) {
            atFirst = true;
        }
    }

    return {
        body: resBody,
        pagination: {
            limit: paginationParams.limit,
            maxLimit: paginationParams.maxLimit,
            before: !atFirst && resBody.length && PaginationCursor.encode(PaginationCursor.build(true, resBody, paginationParams)),
            after: !atLast && resBody.length && PaginationCursor.encode(PaginationCursor.build(false, resBody, paginationParams))
        }
    };
}
