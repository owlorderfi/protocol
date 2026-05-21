import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Order } from '@polyorder/shared';
import { api } from '../lib/api';

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });
}
