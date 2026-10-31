export type Role = 'customer' | 'staff' | 'owner';
export type ApptStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no-show';

export interface Salon {
  id: string; name: string; address: string; phone: string;
  rating: number; reviewsCount: number; images: string[];
}
export interface ServiceCategory { id: string; name: string; icon: string; }
export interface Service {
  id: string; categoryId: string; name: string; desc: string;
  price: number; durationMin: number; image: string;
  popular?: boolean; staffIds: string[];
}
export interface Staff {
  id: string; name: string; role: string; avatar: string;
  rating: number; reviewsCount: number; specialties: string[]; color: string;
}
export interface Customer {
  id: string; name: string; phone: string; avatar: string;
  loyaltyPoints: number; totalVisits: number; lastVisit: string;
}
export interface Appointment {
  id: string; customerId: string; customerName: string;
  serviceId: string; serviceName: string; staffId: string; staffName: string;
  startAt: string; endAt: string; status: ApptStatus; price: number; notes?: string;
}
export interface Review { id: string; customerName: string; serviceName: string; rating: number; comment: string; date: string; }
export interface Offer { id: string; title: string; code: string; discountPct: number; validTill: string; }
export interface TimeSlot { time: string; available: boolean; }
export interface RevenuePoint { date: string; revenue: number; bookings: number; }
export interface DashboardStats {
  revenueToday: number; revenueWeek: number; revenueMonth: number;
  bookingsToday: number; occupancyPct: number; avgRating: number; newCustomers: number;
  revenueDeltaPct: number; bookingsDeltaPct: number;
  series30d: RevenuePoint[]; byCategory: { name: string; value: number }[];
  byStaff: { name: string; bookings: number; revenue: number }[];
}
export interface MockUser { id: string; name: string; role: Role; avatar: string; phone: string; }
