import * as cassava from "cassava";
import * as giftbitRoutes from "giftbit-cassava-routes";
import * as jsonschema from "jsonschema";
import {
    withDbConnection, withDbConnectionDeleteOne, withDbConnectionSelectOne, withDbConnectionUpdateOne,
    withDbReadConnection
} from "../../dbUtils";
import {validateBody} from "../../restUtils";
import {Customer, customerSchema} from "../../model/Customer";
import {SqlSelectResponse} from "../../sqlResponses";
import {getPaginationParams, Pagination, PaginationParams} from "../../model/Pagination";

export function installCustomersRest(router: cassava.Router): void {
    router.route("/v2/customers")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            return {
                body: await getCustomers(auth.giftbitUserId, getPaginationParams(evt))
            };
        });

    router.route("/v2/customers")
        .method("POST")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            validateBody(evt, customerSchema);

            return {
                body: await createCustomer({
                    ...evt.body,
                    userId: auth.giftbitUserId
                })
            };
        });

    router.route("/v2/customers/{customerId}")
        .method("GET")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            return {
                body: await getCustomer(auth.giftbitUserId, evt.pathParameters.customerId)
            };
        });

    router.route("/v2/customers/{customerId}")
        .method("PUT")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            validateBody(evt, customerSchema);

            return {
                body: await updateCustomer({
                    ...evt.body,
                    userId: auth.giftbitUserId,
                    customerId: evt.pathParameters.customerId
                })
            };
        });

    router.route("/v2/customers/{customerId}")
        .method("DELETE")
        .handler(async evt => {
            const auth: giftbitRoutes.jwtauth.AuthorizationBadge = evt.meta["auth"];
            auth.requireIds("giftbitUserId");
            return {
                body: await deleteCustomer(auth.giftbitUserId, evt.pathParameters.customerId)
            };
        });
}

async function getCustomers(userId: string, pagination: PaginationParams): Promise<{customers: Customer[], pagination: Pagination}> {
    return withDbReadConnection(async conn => {
        const res: SqlSelectResponse<Customer> = await conn.query(
            "SELECT * FROM customers WHERE userId = ? ORDER BY customerId LIMIT ?,?",
            [userId, pagination.offset, pagination.limit]
        );
        return {
            customers: res,
            pagination: {
                count: res.length,
                limit: pagination.limit,
                maxLimit: pagination.maxLimit,
                offset: pagination.offset
            }
        };
    });
}

export async function createCustomer(customer: Customer): Promise<Customer> {
    if (!customer.customerId) {
        throw new cassava.RestError(cassava.httpStatusCode.clientError.BAD_REQUEST, "customerId must be set");
    }
    if (customer.customerId.length > 255) {
        throw new cassava.RestError(cassava.httpStatusCode.clientError.BAD_REQUEST, "customerId too long");
    }

    return withDbConnection<Customer>(async conn => {
        try {
            await conn.query(
                "INSERT INTO customers (userId, customerId, firstName, lastName, email) VALUES (?, ?, ?, ?, ?)",
                [customer.userId, customer.customerId, customer.firstName, customer.lastName, customer.email]
            );
            return customer;
        } catch (err) {
            if (err.code === "ER_DUP_ENTRY") {
                throw new cassava.RestError(cassava.httpStatusCode.clientError.CONFLICT, `Customer with customerId '${customer.customerId}' already exists.`);
            }
            throw err;
        }
    });
}

export async function getCustomer(userId: string, customerId: string): Promise<Customer> {
    return withDbConnectionSelectOne<Customer>(
        "SELECT * FROM customers WHERE userId = ? AND customerId = ?",
        [userId, customerId]
    );
}

export async function updateCustomer(customer: Customer): Promise<Customer> {
    await withDbConnectionUpdateOne(
        "UPDATE customers SET firstName = ?, lastName = ?, email = ? WHERE userId = ? AND customerId = ?",
        [customer.firstName, customer.lastName, customer.email, customer.userId, customer.customerId]
    );
    return customer;
}

export async function deleteCustomer(userId: string, customerId: string): Promise<{success: true}> {
    await withDbConnectionDeleteOne(
        "DELETE FROM customers WHERE userId = ? AND customerId = ?",
        [userId, customerId]
    );
    return {success: true};
}
