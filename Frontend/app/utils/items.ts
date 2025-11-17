import axios from "./axiosConfig";

export interface MonthlyStatementQuery {
  participant?: string;
  startDate?: string;
  endDate?: string;
  deliveryStartDate?: string;
  deliveryEndDate?: string;
  limit?: number | string;
  folderName?: string;
  page?: number | string;
  budgetPage?: number | string;
  budgetLimit?: number | string;
  servicePage?: number | string;
  serviceLimit?: number | string;
  month?: string;
  year?: string;
  endpoint?: string;
}

export async function fetchMonthlyStatementItems(
  workspaceId: string,
  boardId: string,
  query: MonthlyStatementQuery = {}
) {
  // Use new unified endpoint if specified, otherwise use legacy endpoint
  const endpoint = query.endpoint || 'monthly-statement';
  const { endpoint: _, ...params } = query; // Remove endpoint from params
  
  const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${workspaceId}/${boardId}/${endpoint}`;
  const response = await axios.get(apiUrl, {
    params,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  return response.data;
}


