import {ValueIdentifier} from "./ValueIdentifier";

export interface AttachValueParameters {
    contactId: string;
    valueIdentifier: ValueIdentifier;
    allowOverwrite: boolean;
    attachGenericAsNewValue?: boolean;
}