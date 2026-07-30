/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord'], (currentRecord) => {

    const pageInit = () => {
        // Required Client Script entry point.
    };

    const printPsiqBom = () => {
        try {
            const workOrder = currentRecord.get();
            const workOrderId = workOrder.id;

            if (!workOrderId) {
                alert('Please save the Work Order before printing the BOM.');
                return;
            }

            /*
             * The User Event resolves this URL server-side, so the Client
             * Script remains portable between Sandbox and Production.
             */
            const suiteletUrl = workOrder.getValue({
                fieldId: 'custpage_psiq_bom_url'
            });

            if (!suiteletUrl) {
                throw new Error(
                    'The PSiQ BOM Suitelet URL is unavailable.'
                );
            }

            window.open(suiteletUrl, '_blank');

        } catch (error) {
            alert(
                'Print PSiQ BOM failed: ' +
                `${error.name || 'ERROR'} - ${error.message || error}`
            );
        }
    };

    return {
        pageInit,
        printPsiqBom
    };
});
