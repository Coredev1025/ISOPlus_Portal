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
}

export async function fetchMonthlyStatementItems(
  workspaceId: string,
  boardId: string,
  query: MonthlyStatementQuery = {}
) {
  const apiUrl = `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/items/${workspaceId}/${boardId}/monthlyStatement`;
  const response = await axios.get(apiUrl, {
    params: query,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  return response.data;
}


