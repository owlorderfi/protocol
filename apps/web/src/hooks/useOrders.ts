import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { Order } from '@polyorder/shared';
import { api, ApiError } from '../lib/api';

export function useOrders(enabled: boolean) {
  return useQuery({
    queryKey: ['orders'],
    queryFn: () => api<Order[]>('/orders'),
    enabled,
    refetchInterval: 5_000, // pick up keeper status changes
  });
}

export function useCancelOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Order>(`/orders/${id}`, { method: 'DELETE' }),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      toast.success(`Order ${order.id.slice(0, 8)}… cancelled`);
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : (err as Error).message;
      toast.error(`Cancel failed: ${msg}`);
    },
  });
}
