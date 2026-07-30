/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/url', 'N/ui/serverWidget'], (url, serverWidget) => {

    const beforeLoad = (context) => {
        if (context.type !== context.UserEventType.VIEW) {
            return;
        }

        // Remove NetSuite's native basic-layout BOM print button.
        context.form.removeButton({
            id: 'printbom'
        });

        const suiteletUrl = url.resolveScript({
            scriptId: 'customscript_psiq_bom_print_',
            deploymentId: 'customdeploy_psiq_bom_print_sl',
            params: {
                woid: context.newRecord.id
            }
        });

        const urlField = context.form.addField({
            id: 'custpage_psiq_bom_url',
            type: serverWidget.FieldType.LONGTEXT,
            label: 'PSiQ BOM URL'
        });

        urlField.updateDisplayType({
            displayType: serverWidget.FieldDisplayType.HIDDEN
        });

        urlField.defaultValue = suiteletUrl;

        context.form.clientScriptModulePath =
            './PSiQ_BOM_Print_CS.js';

        context.form.addButton({
            id: 'custpage_print_psiq_bom',
            label: 'Print PSiQ BOM',
            functionName: 'printPsiqBom'
        });
    };

    return { beforeLoad };
});
