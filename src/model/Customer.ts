import * as giftbitRoutes from "giftbit-cassava-routes";
import {DbCustomer} from "../dbmodel/DbCustomer";

export interface Customer {
    customerId: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    metadata: object | null;
    createdDate: Date;
    updatedDate: Date;
}

export namespace Customer {
    export function toDbCustomer(auth: giftbitRoutes.jwtauth.AuthorizationBadge, c: Customer): DbCustomer {
        return {
            userId: auth.giftbitUserId,
            customerId: c.customerId,
            firstName: c.firstName,
            lastName: c.lastName,
            email: c.email,
            metadata: JSON.stringify(c.metadata),
            createdDate: c.createdDate,
            updatedDate: c.updatedDate
        };
    }
}
