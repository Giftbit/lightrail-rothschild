import papaparse = require("papaparse");

export function csvSerializer(body: any): string {
    if (body instanceof Array) {
        for (let index in body) {
            body[index] = stringifyChildObjects(body[index]);
        }
    } else if (body instanceof Object) {
        body = stringifyChildObjects(body);
    }
    return "data:text/csv;charset=utf-8,\ufeff" + papaparse.unparse(body);
}

function stringifyChildObjects(object: any): any {
    if (object instanceof Object) {
        for (const key of Object.keys(object)) {
            if (object[key] instanceof Object && object[key].toString() === "[object Object]") {
                object[key] = JSON.stringify(object[key]);
            }
        }
        return object;
    } else {
        return object
    }
}