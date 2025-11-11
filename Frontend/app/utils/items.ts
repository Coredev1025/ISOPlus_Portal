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
  const endpoint = query.endpoint || 'monthlyStatement';
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


