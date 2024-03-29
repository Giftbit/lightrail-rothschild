// Adapted from https://github.com/rodrigogs/mysql-events/blob/master/lib/dataNormalizer.js
// If we ever fork ZongJi this logic can probably be folded into there.

const getEventType = (eventName: string): string => {
    return {
        writerows: "INSERT",
        updaterows: "UPDATE",
        deleterows: "DELETE",
    }[eventName];
};

const normalizeRow = (row: any): any => {
    if (!row) return undefined;

    const columns = Object.getOwnPropertyNames(row);
    for (let i = 0, len = columns.length; i < len; i += 1) {
        const columnValue = row[columns[i]];

        if (columnValue instanceof Buffer && columnValue.length === 1) { // It's a boolean
            // <jeffg> I don't see this ever getting called.  zongji/lib/common.readMysqlValue() parses TINYINT to numbers.
            row[columns[i]] = (columnValue[0] > 0);
        }
        if (columnValue instanceof Date) {
            // <jeffg> Because ZongJi constructs Dates in the local timezone, but our server is
            // configured for UTC, we have to adjust the timezone.
            row[columns[i]] = new Date(Date.UTC(columnValue.getFullYear(), columnValue.getMonth(), columnValue.getDate(), columnValue.getHours(), columnValue.getMinutes(), columnValue.getSeconds(), columnValue.getMilliseconds()));
        }
    }

    return row;
};

const hasDifference = (beforeValue: any, afterValue: any): boolean => {
    if ((beforeValue && afterValue) && beforeValue instanceof Date) {
        return beforeValue.getTime() !== afterValue.getTime();
    }

    return beforeValue !== afterValue;
};

const fixRowStructure = (type: string, row: any): any => {
    if (type === "INSERT") {
        row = {
            before: undefined,
            after: row,
        };
    }
    if (type === "DELETE") {
        row = {
            before: row,
            after: undefined,
        };
    }

    return row;
};

const resolveAffectedColumns = (normalizedEvent: any, normalizedRows: any): void => {
    const columns = Object.getOwnPropertyNames((normalizedRows.after || normalizedRows.before));
    for (let i = 0, len = columns.length; i < len; i += 1) {
        const columnName = columns[i];
        const beforeValue = (normalizedRows.before || {})[columnName];
        const afterValue = (normalizedRows.after || {})[columnName];

        if (hasDifference(beforeValue, afterValue)) {
            if (normalizedEvent.affectedColumns.indexOf(columnName) === -1) {
                normalizedEvent.affectedColumns.push(columnName);
            }
        }
    }
};

export const mysqlEventDataNormalizer = (event: any): any => {
    const type = getEventType(event.getEventName());
    const schema = event.tableMap[event.tableId].parentSchema;
    const table = event.tableMap[event.tableId].tableName;
    const {timestamp, nextPosition} = event;

    const normalized = {
        type,
        schema,
        table,
        affectedRows: [],
        affectedColumns: [],
        timestamp,
        nextPosition
    };

    event.rows.forEach((row) => {
        row = fixRowStructure(type, row);

        const normalizedRows = {
            after: normalizeRow(row.after),
            before: normalizeRow(row.before),
        };

        normalized.affectedRows.push(normalizedRows);

        resolveAffectedColumns(normalized, normalizedRows);
    });

    return normalized;
};
