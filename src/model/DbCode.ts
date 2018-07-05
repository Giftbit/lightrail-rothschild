import {AuthorizationBadge} from "giftbit-cassava-routes/dist/jwtauth";
import {computeCodeLookupHash, encryptCode} from "../utils/codeCryptoUtils";

export class DbCode {
    codeEncrypted: string;
    codeHashed: string;
    lastFour: string;

    constructor(plaintextCode: string, genericCode: boolean, auth: AuthorizationBadge) {
        this.codeEncrypted = encryptCode(plaintextCode);
        this.codeHashed = computeCodeLookupHash(plaintextCode, auth);
        this.lastFour = codeLastFour(plaintextCode);
    }
}

/**
 * Done this way to support unicode and emoji characters. Length of emoji characters is often 2.
 */
export function codeLastFour(code: string) {
    const lengthForLastFour = Math.min(code.length, 4);
    return "…" + code.substring(code.length - lengthForLastFour);
}