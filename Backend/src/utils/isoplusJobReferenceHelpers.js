export function buildJobPlanningValues(jobPlanningItemValues) {
  const values = jobPlanningItemValues.values;
  if (!values.some((v) => v.attribute.name === 'Job Number')) {
    throw new Error('Job Number is required');
  }
  if (!values.some((v) => v.attribute.name === "Client's Order Number")) {
    throw new Error("Client's Order Number is required");
  }
  if (!values.some((v) => v.attribute.name === 'Job Title')) {
    throw new Error('Job Title is required');
  }

  return {
    id: jobPlanningItemValues.id,
    jobNumber: values.find((v) => v.attribute.name === 'Job Number').data.toString(),
    clientOrderNumber: values.find((v) => v.attribute.name === "Client's Order Number").data.toString(),
    jobTitle: values.find((v) => v.attribute.name === 'Job Title').data.toString(),
  };
}

export function buildServiceFeeTypeValues(serviceFeeTypeItemValues) {
  const values = serviceFeeTypeItemValues.values;
  if (!values.some((v) => v.attribute.name === 'Fee Type')) {
    throw new Error('Fee Type is required');
  }

  return {
    feeType: values.find((v) => v.attribute.name === 'Fee Type').data.toString(),
    rate: parseFloat(values.find((v) => v.attribute.name === 'Rate($) - GST Excl.').data.toString()),
  };
}
