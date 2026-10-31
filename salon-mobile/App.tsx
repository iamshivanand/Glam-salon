import React, { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import {
  NativeBaseProvider,
  Box,
  Text,
  Button,
  HStack,
  VStack,
  Pressable,
  Badge,
  Divider,
  Modal,
  Input,
  Spinner,
  useToast,
} from 'native-base';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from './theme';
import { useAuth, useBooking, useUi, type Tab } from './store';
import {
  cancelBooking,
  createBooking,
  createInvoice,
  dayLabel,
  getAvailability,
  getSalon,
  holdSlot,
  isOwner,
  istDateTime,
  istTime,
  myBookings,
  nextDays,
  partnerBookings,
  partnerDashboard,
  partnerQueue,
  rupees,
  searchSalons,
  todayIST,
  updateBookingStatus,
  type CreatedBooking,
  type MyBooking,
  type PartnerBooking,
  type Slot,
} from './api';

const qc = new QueryClient();
const PLUM = '#2D1B2E';

const STATUS_SCHEME: Record<string, string> = {
  REQUESTED: 'blue',
  CONFIRMED: 'green',
  ARRIVED: 'orange',
  IN_SERVICE: 'orange',
  COMPLETED: 'green',
  NO_SHOW: 'red',
  DECLINED: 'red',
  EXPIRED: 'coolGray',
  CANCELLED_BY_CUSTOMER: 'red',
  CANCELLED_BY_SALON: 'red',
  WAITING: 'blue',
  CALLED: 'orange',
};

const statusLabel = (status: string) => status.replace(/_/g, ' ').toLowerCase();

const DEMO_ACCOUNTS: [string, string][] = [
  ['+919800000002', 'Customer'],
  ['+919800000001', 'Owner'],
];

function useSalons() {
  return useQuery({
    queryKey: ['salons'],
    queryFn: () => searchSalons({ lat: 12.9719, lng: 77.6412, radius_km: 15 }),
    staleTime: 60_000,
  });
}

function useActiveSalon() {
  const b = useBooking();
  const { data } = useSalons();
  const salons = data?.salons ?? [];
  const activeSalonId = b.salonId ?? salons[0]?.id;

  useEffect(() => {
    if (!b.salonId && salons[0]) b.setSalon(salons[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salons, b.salonId]);

  return { salons, activeSalonId };
}

// ------------------------------------------------------------------ Home
function Home({ go }: { go: (tab: Tab) => void }) {
  const b = useBooking();
  const { salons, activeSalonId } = useActiveSalon();
  const { data: profile, isLoading: loadingProfile } = useQuery({
    queryKey: ['salon', activeSalonId],
    queryFn: () => getSalon(activeSalonId!),
    enabled: !!activeSalonId,
  });
  const { data: search, isLoading, error } = useSalons();

  const services = (profile?.services ?? []).slice(0, 5);
  const staff = (profile?.staff ?? []).slice(0, 4);

  return (
    <ScrollView>
      <Box p={5}>
        <Text fontSize="sm" color="gold.500" bold>
          ★ {profile?.avg_rating ?? '—'} · {profile?.review_count ?? 0} reviews
        </Text>
        <Text fontFamily="heading" fontSize="4xl" mt={1}>
          Beauty rituals,{'\n'}booked in seconds.
        </Text>
        <Text fontSize="sm" color="coolGray.500" mt={2}>
          {profile ? `${profile.name} · ${profile.locality}, ${profile.city}` : 'Finding salons near Indiranagar…'}
        </Text>
        <Button bg="plum.500" mt={4} onPress={() => go('book')}>
          Book appointment
        </Button>

        {isLoading && (
          <HStack mt={8} alignItems="center" space={2}>
            <Spinner color="gold.500" />
            <Text color="coolGray.500">Loading live salons…</Text>
          </HStack>
        )}
        {!!error && (
          <Box mt={6} bg="red.50" p={3} borderRadius={12}>
            <Text color="red.600" fontSize="sm">
              {(error as Error).message}
            </Text>
          </Box>
        )}

        {!!search && (
          <>
            <Text fontFamily="heading" fontSize="2xl" mt={6} mb={2}>
              Salons near you
            </Text>
            {salons.map((s) => (
              <Pressable
                key={s.id}
                mb={3}
                onPress={() => {
                  b.setSalon(s.id);
                  go('book');
                }}
              >
                <Box
                  bg="white"
                  borderRadius={22}
                  p={4}
                  borderWidth={1}
                  borderColor={s.id === activeSalonId ? 'gold.400' : 'transparent'}
                >
                  <HStack justifyContent="space-between" alignItems="flex-start">
                    <VStack flex={1} pr={2}>
                      <Text bold>{s.name}</Text>
                      <Text fontSize="xs" color="coolGray.500" mt={0.5}>
                        {s.locality} · {s.distance_km != null ? `${s.distance_km} km` : s.city}
                      </Text>
                    </VStack>
                    <VStack alignItems="flex-end">
                      <Text bold color="gold.500">
                        ★ {s.avg_rating}
                      </Text>
                      <Text fontSize="xs" color="coolGray.500">
                        {s.review_count} reviews
                      </Text>
                    </VStack>
                  </HStack>
                  <HStack mt={2} justifyContent="space-between" alignItems="center">
                    <Text fontSize="sm">
                      From <Text bold>{rupees(s.starting_price_paise)}</Text>
                    </Text>
                    {s.live_queue.waiting_count > 0 ? (
                      <Text fontSize="xs" color="orange.500">
                        {s.live_queue.waiting_count} in walk-in queue
                      </Text>
                    ) : (
                      <Text fontSize="xs" color="green.600">
                        Walk-ins open
                      </Text>
                    )}
                  </HStack>
                </Box>
              </Pressable>
            ))}

            <Text fontFamily="heading" fontSize="2xl" mt={4} mb={2}>
              Popular at {profile?.name.split(' ')[0] ?? 'the salon'}
            </Text>
            {loadingProfile && <Spinner color="gold.500" />}
            {services.map((s) => {
              const price = s.discounted_price_paise ?? s.base_price_paise;
              return (
                <Pressable
                  key={s.id}
                  mb={2}
                  onPress={() => {
                    if (b.salonId !== activeSalonId) b.setSalon(activeSalonId!);
                    b.toggleService(s.id);
                    go('book');
                  }}
                >
                  <HStack bg="white" p={3} borderRadius={16} alignItems="center">
                    <VStack flex={1} pr={2}>
                      <Text bold>{s.custom_name}</Text>
                      <Text fontSize="xs" color="coolGray.500">
                        {s.category_name} · {s.duration_mins} min
                      </Text>
                    </VStack>
                    <Text bold>{rupees(price)}</Text>
                  </HStack>
                </Pressable>
              );
            })}

            {staff.length > 0 && (
              <>
                <Text fontFamily="heading" fontSize="2xl" mt={5} mb={2}>
                  Top artists
                </Text>
                <HStack space={3}>
                  {staff.map((p) => (
                    <VStack key={p.id} alignItems="center" bg="white" p={3} borderRadius={16} flex={1}>
                      <Box
                        w={12}
                        h={12}
                        borderRadius="full"
                        bg="gold.400:alpha.30"
                        alignItems="center"
                        justifyContent="center"
                      >
                        <Text bold color="plum.500">
                          {p.display_name
                            .split(' ')
                            .map((w) => w[0])
                            .join('')
                            .slice(0, 2)}
                        </Text>
                      </Box>
                      <Text bold fontSize="xs" mt={2} numberOfLines={1}>
                        {p.display_name.split(' ')[0]}
                      </Text>
                      <Text fontSize="xs" color="coolGray.500">
                        ★ {p.avg_rating}
                      </Text>
                    </VStack>
                  ))}
                </HStack>
              </>
            )}
          </>
        )}
      </Box>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Booking
function Booking() {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CreatedBooking | null>(null);

  const queryClient = useQueryClient();
  const b = useBooking();
  const { user } = useAuth();
  const { openAuth } = useUi();
  const resumeBooking = useUi((s) => s.resumeBooking);

  const { salons, activeSalonId } = useActiveSalon();
  const { data: profile, isLoading: loadingProfile } = useQuery({
    queryKey: ['salon', activeSalonId],
    queryFn: () => getSalon(activeSalonId!),
    enabled: !!activeSalonId,
  });

  const availability = useQuery({
    queryKey: ['availability', activeSalonId, b.serviceIds.join(','), b.date, b.staffId],
    queryFn: () => getAvailability(activeSalonId!, b.serviceIds, b.date, b.staffId),
    enabled: !!activeSalonId && b.serviceIds.length > 0,
  });

  const selected = useMemo(
    () => (profile?.services ?? []).filter((s) => b.serviceIds.includes(s.id)),
    [profile, b.serviceIds],
  );
  const total = selected.reduce((sum, s) => sum + (s.discounted_price_paise ?? s.base_price_paise), 0);

  // With "Anyone" the API returns one slot per available artist, so the same time
  // can appear twice. Collapse to unique start times unless an artist is chosen.
  const slots: Slot[] = useMemo(() => {
    const all = availability.data?.slots ?? [];
    if (b.staffId) return all;
    const seen = new Set<string>();
    return all.filter((s) => (seen.has(s.start) ? false : (seen.add(s.start), true)));
  }, [availability.data, b.staffId]);

  const confirm = async () => {
    if (!activeSalonId) return;
    if (!user) {
      openAuth('Sign in to lock your slot and confirm the booking.', true);
      return;
    }
    const slot = slots.find((s) => s.start === b.time);
    if (!slot) {
      setError('Pick a time slot to continue.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const held = await holdSlot({
        salon_id: activeSalonId,
        service_ids: b.serviceIds,
        staff_id: slot.staff_id,
        start_at: slot.start_at,
      });
      const booking = await createBooking(held.hold_token);
      setConfirmation(booking);
      b.reset();
      setStep(4);
      queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
    } catch (err: any) {
      setError(err?.message ?? 'Could not confirm this booking. Please pick another slot.');
    } finally {
      setBusy(false);
    }
  };

  // Finish the booking automatically once the OTP modal signs the customer in.
  useEffect(() => {
    if (!resumeBooking || !user) return;
    useUi.getState().clearResume();
    void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeBooking, user]);

  return (
    <ScrollView>
      <Box p={5}>
        <HStack space={1} mb={4}>
          {[1, 2, 3, 4].map((i) => (
            <Box key={i} flex={1} h={2} borderRadius="full" bg={i <= step ? 'gold.400' : 'coolGray.200'} />
          ))}
        </HStack>
        <Text fontFamily="heading" fontSize="3xl">Book your visit</Text>
        <Text fontSize="sm" color="coolGray.500" mt={1}>
          Real-time availability across Glam Connect salons.
        </Text>

        {step === 1 && (
          <VStack space={2} mt={4}>
            <Text bold>Salon</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <HStack space={2}>
                {salons.map((s) => (
                  <Button
                    key={s.id}
                    size="sm"
                    variant={s.id === activeSalonId ? 'solid' : 'outline'}
                    bg={s.id === activeSalonId ? 'plum.500' : undefined}
                    onPress={() => b.setSalon(s.id)}
                  >
                    {s.name.split(' ')[0]}
                  </Button>
                ))}
              </HStack>
            </ScrollView>

            {loadingProfile && <Spinner color="gold.500" mt={4} />}
            {!loadingProfile && !profile && (
              <Text color="coolGray.500" mt={2}>
                Pick a salon to see its services.
              </Text>
            )}
            {(profile?.services ?? []).map((s) => {
              const added = b.serviceIds.includes(s.id);
              return (
                <Pressable key={s.id} onPress={() => b.toggleService(s.id)}>
                  <HStack
                    bg={added ? 'gold.400:alpha.20' : 'white'}
                    p={3}
                    borderRadius={16}
                    alignItems="center"
                  >
                    <VStack flex={1} pr={2}>
                      <Text bold>{s.custom_name}</Text>
                      <Text fontSize="xs" color="coolGray.500">
                        {s.category_name} · {s.duration_mins} min
                      </Text>
                    </VStack>
                    <Text bold mr={2}>{rupees(s.discounted_price_paise ?? s.base_price_paise)}</Text>
                    <Badge colorScheme={added ? 'amber' : 'coolGray'}>{added ? 'Added' : 'Add'}</Badge>
                  </HStack>
                </Pressable>
              );
            })}

            <Button
              bg="plum.500"
              mt={2}
              isDisabled={!b.serviceIds.length}
              onPress={() => setStep(2)}
            >
              Continue{selected.length ? ` · ${rupees(total)}` : ''}
            </Button>
          </VStack>
        )}

        {step === 2 && (
          <VStack space={3} mt={4}>
            <Text bold>Artist</Text>
            <HStack space={2} flexWrap="wrap">
              <Button
                size="sm"
                mb={1}
                variant={b.staffId ? 'outline' : 'solid'}
                bg={b.staffId ? undefined : 'plum.500'}
                onPress={() => b.set({ staffId: undefined })}
              >
                Anyone
              </Button>
              {(profile?.staff ?? []).map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  mb={1}
                  variant={b.staffId === p.id ? 'solid' : 'outline'}
                  bg={b.staffId === p.id ? 'plum.500' : undefined}
                  onPress={() => b.set({ staffId: p.id })}
                >
                  {p.display_name.split(' ')[0]} ★{p.avg_rating}
                </Button>
              ))}
            </HStack>

            <HStack justifyContent="space-between" alignItems="center">
              <Text bold>Date</Text>
              <Text fontSize="xs" color="coolGray.500">
                {availability.data ? `${availability.data.total_duration_mins} min total` : ''}
              </Text>
            </HStack>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <HStack space={2}>
                {nextDays(7).map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant={b.date === d ? 'solid' : 'outline'}
                    bg={b.date === d ? 'plum.500' : undefined}
                    onPress={() => b.set({ date: d })}
                  >
                    {dayLabel(d)}
                  </Button>
                ))}
              </HStack>
            </ScrollView>

            <Text bold>Time</Text>
            {availability.isLoading && <Spinner color="gold.500" />}
            {!!availability.error && (
              <Text color="red.500" fontSize="sm">
                {(availability.error as Error).message}
              </Text>
            )}
            {availability.data && slots.length === 0 && (
              <Text color="coolGray.500" fontSize="sm">
                No open slots on {dayLabel(b.date)}. Try another date or artist.
              </Text>
            )}
            <HStack flexWrap="wrap" justifyContent="space-between">
              {slots.map((s) => (
                <Button
                  key={`${s.start}-${s.staff_id}`}
                  size="sm"
                  w="31%"
                  mb={2}
                  variant={b.time === s.start ? 'solid' : 'outline'}
                  bg={b.time === s.start ? 'gold.400' : undefined}
                  _text={{ color: b.time === s.start ? PLUM : undefined }}
                  onPress={() => b.set({ time: s.start })}
                >
                  {s.start}
                </Button>
              ))}
            </HStack>

            <HStack space={2} mt={1}>
              <Button variant="outline" flex={1} onPress={() => setStep(1)}>
                Back
              </Button>
              <Button
                bg="plum.500"
                flex={2}
                isDisabled={!b.time}
                onPress={() => setStep(3)}
              >
                Continue
              </Button>
            </HStack>
          </VStack>
        )}

        {step === 3 && (
          <VStack space={3} mt={4} bg="white" p={4} borderRadius={22}>
            <Text fontSize="xs" color="coolGray.500">
              {profile?.name} · {dayLabel(b.date)} at {b.time}
            </Text>
            {selected.map((s) => (
              <HStack key={s.id} justifyContent="space-between">
                <Text flex={1} pr={2} fontSize="sm">
                  {s.custom_name}
                </Text>
                <Text fontSize="sm">{rupees(s.discounted_price_paise ?? s.base_price_paise)}</Text>
              </HStack>
            ))}
            <Divider />
            <HStack justifyContent="space-between" alignItems="center">
              <Text bold>Total</Text>
              <Text fontFamily="heading" fontSize="3xl">{rupees(total)}</Text>
            </HStack>

            {!!error && (
              <Box bg="red.50" p={2} borderRadius={8}>
                <Text color="red.600" fontSize="sm">{error}</Text>
              </Box>
            )}

            {user ? (
              <Button bg="gold.400" _text={{ color: PLUM }} onPress={confirm} isLoading={busy}>
                Confirm booking
              </Button>
            ) : (
              <Button
                bg="gold.400"
                _text={{ color: PLUM }}
                onPress={() => openAuth('Sign in to lock your slot and confirm the booking.', true)}
              >
                Sign in &amp; confirm
              </Button>
            )}
            <Text fontSize="xs" color="coolGray.500" textAlign="center">
              Your slot is held for 5 minutes while you confirm. Payment is collected at the salon.
            </Text>
            <Button variant="ghost" onPress={() => setStep(2)}>
              Back
            </Button>
          </VStack>
        )}

        {step === 4 && confirmation && (
          <VStack mt={6} alignItems="center" bg="white" p={6} borderRadius={22}>
            <Text fontSize="5xl">✨</Text>
            <Text fontFamily="heading" fontSize="3xl" mt={2}>You’re booked!</Text>
            <Text mt={2} fontSize="sm" color="coolGray.500">
              {istDateTime(confirmation.scheduled_start_at)}
            </Text>
            <Text mt={4} fontSize="xs" color="coolGray.500" letterSpacing={1}>BOOKING CODE</Text>
            <Text bold fontSize="xl">{confirmation.booking_code}</Text>
            <Text mt={2} fontSize="xs" color="coolGray.500" letterSpacing={1}>CHECK-IN PIN</Text>
            <Text bold fontSize="xl">{confirmation.checkin_pin}</Text>
            <Text mt={3} fontSize="sm">
              Total {rupees(confirmation.total_payable_paise)} · pay at the salon
            </Text>
            <Button
              mt={5}
              bg="plum.500"
              onPress={() => {
                setStep(1);
                setConfirmation(null);
                useUi.getState().setTab('visits');
              }}
            >
              View my visits
            </Button>
            <Button
              variant="ghost"
              mt={1}
              onPress={() => {
                setStep(1);
                setConfirmation(null);
              }}
            >
              Book another
            </Button>
          </VStack>
        )}
      </Box>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Visits
function Visits() {
  const { user } = useAuth();
  const { openAuth } = useUi();
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data, isLoading, error } = useQuery({
    queryKey: ['my-bookings'],
    queryFn: myBookings,
    enabled: !!user,
  });

  const cancel = useMutation({
    mutationFn: (id: string) => cancelBooking(id, 'Changed plans'),
    onSuccess: () => {
      toast.show({ description: 'Booking cancelled' });
      queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
    },
    onError: (err: any) => toast.show({ description: err?.message ?? 'Could not cancel', bg: 'red.500' }),
  });

  if (!user) {
    return (
      <ScrollView>
        <Box p={6} mt={8} bg="white" borderRadius={22}>
          <Text fontFamily="heading" fontSize="2xl">My visits</Text>
          <Text color="coolGray.500" mt={2}>
            Sign in with your phone number to see bookings, check-in PINs and receipts.
          </Text>
          <Button mt={4} bg="plum.500" onPress={() => openAuth()}>
            Sign in
          </Button>
        </Box>
      </ScrollView>
    );
  }

  const bookings: MyBooking[] = data?.bookings ?? [];

  return (
    <ScrollView>
      <VStack p={5} space={3}>
        <Text fontFamily="heading" fontSize="3xl">My visits</Text>
        {isLoading && <Spinner color="gold.500" />}
        {!!error && <Text color="red.500">{(error as Error).message}</Text>}
        {!isLoading && bookings.length === 0 && (
          <Box bg="white" p={4} borderRadius={16}>
            <Text color="coolGray.500">No bookings yet. Your first visit is one tap away.</Text>
            <Button mt={3} size="sm" bg="plum.500" onPress={() => useUi.getState().setTab('book')}>
              Book now
            </Button>
          </Box>
        )}
        {bookings.map((a) => {
          const cancellable = ['REQUESTED', 'CONFIRMED'].includes(a.status);
          return (
            <Box key={a.id} bg="white" p={4} borderRadius={16}>
              <HStack justifyContent="space-between" alignItems="flex-start">
                <VStack flex={1} pr={2}>
                  <Text bold>{a.salon_name}</Text>
                  <Text fontSize="xs" color="coolGray.500">{a.locality} · {a.city}</Text>
                </VStack>
                <Badge colorScheme={STATUS_SCHEME[a.status] ?? 'coolGray'}>
                  {statusLabel(a.status)}
                </Badge>
              </HStack>
              <Text fontSize="sm" mt={2}>{istDateTime(a.scheduled_start_at)}</Text>
              <HStack justifyContent="space-between" alignItems="center" mt={1}>
                <Text fontSize="xs" color="coolGray.500">{a.booking_code}</Text>
                <Text bold>{rupees(a.total_payable_paise)}</Text>
              </HStack>
              {a.checkin_pin && a.status === 'CONFIRMED' && (
                <Text fontSize="xs" color="coolGray.500" mt={1}>Check-in PIN {a.checkin_pin}</Text>
              )}
              {cancellable && (
                <Button
                  mt={3}
                  size="sm"
                  variant="outline"
                  colorScheme="red"
                  isLoading={cancel.isPending}
                  onPress={() =>
                    Alert.alert('Cancel booking?', `${a.booking_code} at ${a.salon_name}`, [
                      { text: 'Keep it', style: 'cancel' },
                      { text: 'Cancel booking', style: 'destructive', onPress: () => cancel.mutate(a.id) },
                    ])
                  }
                >
                  Cancel booking
                </Button>
              )}
            </Box>
          );
        })}
      </VStack>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Admin
const NEXT_ACTION: Record<string, { label: string; status: string }[]> = {
  REQUESTED: [
    { label: 'Confirm', status: 'CONFIRMED' },
    { label: 'Decline', status: 'DECLINED' },
  ],
  CONFIRMED: [
    { label: 'Check in', status: 'ARRIVED' },
    { label: 'No show', status: 'NO_SHOW' },
  ],
  ARRIVED: [{ label: 'Start service', status: 'IN_SERVICE' }],
};

function Admin() {
  const { user, logout } = useAuth();
  const { openAuth } = useUi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const owner = isOwner(user);
  const today = todayIST();

  const dashboard = useQuery({
    queryKey: ['partner', 'dashboard'],
    queryFn: () => partnerDashboard('MONTH'),
    enabled: owner,
  });
  const day = useQuery({
    queryKey: ['partner', 'bookings', today],
    queryFn: () => partnerBookings(today),
    enabled: owner,
  });
  const queue = useQuery({
    queryKey: ['partner', 'queue'],
    queryFn: partnerQueue,
    enabled: owner,
  });

  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateBookingStatus(id, status),
    onSuccess: (_res, vars) => {
      toast.show({ description: `Booking moved to ${statusLabel(vars.status)}` });
      queryClient.invalidateQueries({ queryKey: ['partner'] });
    },
    onError: (err: any) => toast.show({ description: err?.message ?? 'Update failed', bg: 'red.500' }),
  });

  const invoice = useMutation({
    mutationFn: ({ id, method }: { id: string; method: 'UPI_QR' | 'CASH' }) => createInvoice(id, method),
    onSuccess: (res) => {
      toast.show({ description: `${res.invoice_number} · collected ${rupees(res.net_collected_paise)}` });
      queryClient.invalidateQueries({ queryKey: ['partner'] });
    },
    onError: (err: any) => toast.show({ description: err?.message ?? 'Billing failed', bg: 'red.500' }),
  });

  if (!user) {
    return (
      <ScrollView>
        <Box p={6} mt={8} bg="white" borderRadius={22}>
          <Text fontFamily="heading" fontSize="2xl">Salon console</Text>
          <Text color="coolGray.500" mt={2}>
            Sign in with the salon owner account to see revenue, the day book and the live queue.
          </Text>
          <Button mt={4} bg="plum.500" onPress={() => openAuth()}>
            Sign in
          </Button>
        </Box>
      </ScrollView>
    );
  }

  if (!owner) {
    return (
      <ScrollView>
        <Box p={6} mt={8} bg="white" borderRadius={22}>
          <Text fontFamily="heading" fontSize="2xl">Owners only</Text>
          <Text color="coolGray.500" mt={2}>
            You are signed in as {user.full_name} (customer). Use the owner demo account to open the console.
          </Text>
          <Button
            mt={4}
            bg="plum.500"
            onPress={() => {
              logout();
              openAuth('Sign in with the salon owner account.');
            }}
          >
            Switch account
          </Button>
        </Box>
      </ScrollView>
    );
  }

  const s = dashboard.data;
  const bookings: PartnerBooking[] = day.data?.bookings ?? [];
  const maxRevenue = Math.max(1, ...(s?.revenue_by_staff ?? []).map((r) => r.revenue_paise));

  return (
    <ScrollView>
      <VStack p={5} space={4}>
        <VStack>
          <Text fontFamily="heading" fontSize="3xl">Salon overview</Text>
          <Text fontSize="xs" color="coolGray.500">Live data for {dayLabel(today)} (IST)</Text>
        </VStack>

        {dashboard.isLoading && <Spinner color="gold.500" />}
        {!!dashboard.error && <Text color="red.500">{(dashboard.error as Error).message}</Text>}

        {s && (
          <>
            <HStack space={2}>
              <Box bg="white" p={3} borderRadius={16} flex={1}>
                <Text fontSize="xs" color="coolGray.500">Revenue · 30 days</Text>
                <Text bold fontSize="lg">{rupees(s.revenue_paise)}</Text>
                <Text fontSize="xs" color="coolGray.500">{s.completed_visits} visits</Text>
              </Box>
              <Box bg="white" p={3} borderRadius={16} flex={1}>
                <Text fontSize="xs" color="coolGray.500">Average bill</Text>
                <Text bold fontSize="lg">{rupees(s.avg_bill_paise)}</Text>
                <Text fontSize="xs" color="coolGray.500">{s.completed_services} services</Text>
              </Box>
            </HStack>
            <HStack space={2}>
              <Box bg="white" p={3} borderRadius={16} flex={1}>
                <Text fontSize="xs" color="coolGray.500">Retention</Text>
                <Text bold fontSize="lg">{s.retention_rate_pct}%</Text>
                <Text fontSize="xs" color="coolGray.500">
                  {s.returning_customers} returning · {s.new_customers} new
                </Text>
              </Box>
              <Box bg="white" p={3} borderRadius={16} flex={1}>
                <Text fontSize="xs" color="coolGray.500">Reminder conversion</Text>
                <Text bold fontSize="lg">{s.reminder_conversion_rate_pct}%</Text>
              </Box>
            </HStack>

            <Box bg="white" p={3} borderRadius={22}>
              <Text bold mb={2}>Revenue by artist · last 30 days</Text>
              {s.revenue_by_staff.length === 0 && (
                <Text fontSize="sm" color="coolGray.500">No completed services yet.</Text>
              )}
              {s.revenue_by_staff.map((r) => (
                <Box key={r.staff_name} mb={2}>
                  <HStack justifyContent="space-between">
                    <Text fontSize="xs">{r.staff_name}</Text>
                    <Text fontSize="xs" bold>{rupees(r.revenue_paise)}</Text>
                  </HStack>
                  <Box h={2} bg="coolGray.100" borderRadius="full" mt={1} overflow="hidden">
                    <Box
                      h={2}
                      bg="gold.400"
                      borderRadius="full"
                      width={`${Math.max(4, Math.round((r.revenue_paise / maxRevenue) * 100))}%`}
                    />
                  </Box>
                </Box>
              ))}
            </Box>
          </>
        )}

        <Box bg="white" p={3} borderRadius={22}>
          <Text bold mb={2}>Live queue</Text>
          {queue.isLoading && <Spinner color="gold.500" />}
          <HStack alignItems="baseline" space={2}>
            <Text fontFamily="heading" fontSize="4xl">{queue.data?.now_serving_token ?? '—'}</Text>
            <Text fontSize="xs" color="coolGray.500">now serving</Text>
          </HStack>
          <Text fontSize="sm" color="coolGray.500" mt={1}>
            {queue.data?.waiting_count ?? 0} waiting
          </Text>
          {(queue.data?.queue ?? []).slice(0, 6).map((t) => (
            <HStack
              key={`${t.token_number}-${t.customer_name}`}
              justifyContent="space-between"
              borderBottomWidth={1}
              borderColor="coolGray.100"
              py={1}
            >
              <Text fontSize="sm">#{t.token_number} {t.customer_name}</Text>
              <Text fontSize="xs" color="coolGray.500">{statusLabel(t.status)}</Text>
            </HStack>
          ))}
          {queue.data?.walkin_paused && (
            <Text fontSize="xs" color="red.500" mt={2}>Remote walk-ins paused</Text>
          )}
        </Box>

        <Box bg="white" p={3} borderRadius={22}>
          <Text bold mb={2}>Today’s appointments</Text>
          {day.isLoading && <Spinner color="gold.500" />}
          {!day.isLoading && bookings.length === 0 && (
            <Text fontSize="sm" color="coolGray.500">No bookings today.</Text>
          )}
          {bookings.map((bk) => (
            <Box key={bk.id} borderBottomWidth={1} borderColor="coolGray.100" py={2}>
              <HStack justifyContent="space-between" alignItems="flex-start">
                <VStack flex={1} pr={2}>
                  <Text bold fontSize="sm">
                    {istTime(bk.scheduled_start_at)} · {bk.customer_name}
                  </Text>
                  <Text fontSize="xs" color="coolGray.500">
                    {bk.items.map((i) => i.service_name).join(', ')}
                  </Text>
                  <Text fontSize="xs" color="coolGray.500">{bk.booking_code}</Text>
                </VStack>
                <VStack alignItems="flex-end">
                  <Text bold fontSize="sm">{rupees(bk.total_payable_paise)}</Text>
                  <Badge colorScheme={STATUS_SCHEME[bk.status] ?? 'coolGray'} mt={1}>
                    {statusLabel(bk.status)}
                  </Badge>
                </VStack>
              </HStack>

              <HStack space={2} mt={2} flexWrap="wrap">
                {(NEXT_ACTION[bk.status] ?? []).map((a) => (
                  <Button
                    key={a.status}
                    size="xs"
                    variant="outline"
                    mb={1}
                    isLoading={update.isPending}
                    onPress={() => update.mutate({ id: bk.id, status: a.status })}
                  >
                    {a.label}
                  </Button>
                ))}
                {['ARRIVED', 'IN_SERVICE'].includes(bk.status) && (
                  <>
                    <Button
                      size="xs"
                      mb={1}
                      bg="gold.400"
                      _text={{ color: PLUM }}
                      isLoading={invoice.isPending}
                      onPress={() => invoice.mutate({ id: bk.id, method: 'UPI_QR' })}
                    >
                      Bill · UPI
                    </Button>
                    <Button
                      size="xs"
                      mb={1}
                      variant="outline"
                      isLoading={invoice.isPending}
                      onPress={() => invoice.mutate({ id: bk.id, method: 'CASH' })}
                    >
                      Cash
                    </Button>
                  </>
                )}
                {bk.status === 'COMPLETED' && (
                  <Text fontSize="xs" color="coolGray.400" alignSelf="center">Settled</Text>
                )}
              </HStack>
            </Box>
          ))}
        </Box>
      </VStack>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Auth modal
function AuthModal() {
  const { authOpen, authReason, closeAuth } = useUi();
  const { requestOtp: sendOtp, verifyOtp: confirmOtp } = useAuth();
  const toast = useToast();

  const [phone, setPhone] = useState('+919800000002');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authOpen) {
      setStep('phone');
      setChallengeId(null);
      setDevOtp(null);
      setCode('');
      setName('');
      setError(null);
      setBusy(false);
    }
  }, [authOpen]);

  const normalize = (raw: string) => {
    const cleaned = raw.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.length === 10) return `+91${cleaned}`;
    if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
    return cleaned;
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await sendOtp(normalize(phone));
      setChallengeId(res.challenge_id);
      setDevOtp(res.dev_otp ?? null);
      if (res.dev_otp) setCode(res.dev_otp);
      setStep('code');
    } catch (err: any) {
      setError(err?.message ?? 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      const user = await confirmOtp(challengeId, code.trim(), name.trim() || undefined);
      toast.show({ description: `Signed in as ${user.full_name}` });
      closeAuth(true);
    } catch (err: any) {
      setError(err?.message ?? 'That code did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={authOpen} onClose={() => closeAuth()} avoidKeyboard size="lg">
      <Modal.Content bg="white" borderRadius={22}>
        <Modal.CloseButton />
        <Modal.Header borderBottomWidth={0} bg="transparent">
          <Text fontFamily="heading" fontSize="2xl">
            {step === 'phone' ? 'Sign in to Glam Connect' : 'Enter your code'}
          </Text>
        </Modal.Header>
        <Modal.Body>
          {step === 'phone' ? (
            <VStack space={3}>
              {!!authReason && (
                <Text fontSize="sm" color="coolGray.500">{authReason}</Text>
              )}
              <Text fontSize="xs" color="coolGray.500" letterSpacing={1}>PHONE NUMBER</Text>
              <Input
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoCapitalize="none"
                placeholder="+919800000002"
                bg="coolGray.50"
              />
              <HStack space={2} flexWrap="wrap">
                {DEMO_ACCOUNTS.map(([number, label]) => (
                  <Button key={number} size="xs" variant="outline" mb={1} onPress={() => setPhone(number)}>
                    {label}
                  </Button>
                ))}
              </HStack>
              {!!error && <Text color="red.500" fontSize="sm">{error}</Text>}
              <Button bg="plum.500" onPress={send} isLoading={busy}>
                Send OTP
              </Button>
              <Text fontSize="xs" color="coolGray.500">
                In development the API returns the code, so it is filled in for you.
              </Text>
            </VStack>
          ) : (
            <VStack space={3}>
              <Text fontSize="sm" color="coolGray.500">Sent to {phone}</Text>
              {devOtp && (
                <Box bg="gold.400:alpha.20" p={2} borderRadius={8}>
                  <Text fontSize="sm">Dev mode — your OTP is <Text bold>{devOtp}</Text></Text>
                </Box>
              )}
              <Input
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                placeholder="6-digit code"
                maxLength={6}
                bg="coolGray.50"
              />
              <Input
                value={name}
                onChangeText={setName}
                placeholder="Your name (new customers only)"
                bg="coolGray.50"
              />
              {!!error && <Text color="red.500" fontSize="sm">{error}</Text>}
              <Button bg="plum.500" onPress={verify} isLoading={busy} isDisabled={code.trim().length < 4}>
                Verify &amp; continue
              </Button>
              <Button variant="ghost" size="sm" onPress={() => setStep('phone')}>
                Change number
              </Button>
            </VStack>
          )}
        </Modal.Body>
      </Modal.Content>
    </Modal>
  );
}

// ------------------------------------------------------------------ Shell
const TABS: [Tab, string][] = [
  ['home', 'Home'],
  ['book', 'Book'],
  ['visits', 'Visits'],
  ['admin', 'Admin'],
];

function Shell() {
  const { tab, setTab } = useUi();
  const { user, logout } = useAuth();
  const owner = isOwner(user);

  return (
    <VStack flex={1} bg="cream.50" safeArea>
      <HStack p={4} alignItems="center" space={2}>
        <VStack flex={1}>
          <Text fontFamily="heading" fontSize="2xl">
            Glam Connect <Text color="gold.500">✦</Text>
          </Text>
          {user && (
            <Text fontSize="xs" color="coolGray.500">
              {user.full_name}{owner ? ' · owner' : ''}
            </Text>
          )}
        </VStack>
        {user ? (
          <Button size="sm" variant="outline" onPress={logout}>
            Sign out
          </Button>
        ) : (
          <Button size="sm" bg="plum.500" onPress={() => useUi.getState().openAuth()}>
            Sign in
          </Button>
        )}
      </HStack>

      <Box flex={1}>
        {tab === 'home' && <Home go={setTab} />}
        {tab === 'book' && <Booking />}
        {tab === 'visits' && <Visits />}
        {tab === 'admin' && <Admin />}
      </Box>

      <Divider />
      <HStack p={3} justifyContent="space-around" bg="white">
        {TABS.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={tab === key ? 'solid' : 'ghost'}
            bg={tab === key ? 'plum.500' : undefined}
            _text={{ color: tab === key ? 'white' : undefined }}
            onPress={() => setTab(key)}
          >
            {label}
          </Button>
        ))}
      </HStack>

      <AuthModal />
    </VStack>
  );
}

export default function App() {
  return (
    <NativeBaseProvider theme={theme}>
      <QueryClientProvider client={qc}>
        <Shell />
      </QueryClientProvider>
    </NativeBaseProvider>
  );
}
