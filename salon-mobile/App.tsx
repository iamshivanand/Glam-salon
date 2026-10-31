import React, { useEffect, useState } from 'react';
import { ScrollView, Image } from 'react-native';
import { NativeBaseProvider, Box, Text, Button, HStack, VStack, Avatar, Pressable, Badge, Divider, useToast } from 'native-base';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { VictoryLine, VictoryPie, VictoryBar } from 'victory-native';
import { theme } from './theme';
import { mockApi, useAuth, useBooking } from './store';

const qc = new QueryClient();
const GOLD = '#C9A86A', PLUM = '#2D1B2E';

function Home({ go }: { go: (t: string) => void }) {
  const { data: services = [] } = useQuery({ queryKey: ['services'], queryFn: mockApi.getServices });
  const { data: staff = [] } = useQuery({ queryKey: ['staff'], queryFn: mockApi.getStaff });
  const b = useBooking();
  return (
    <ScrollView>
      <Box p={5}>
        <Text fontSize="sm" color="gold.500" bold>★ 4.8 · 2,314 reviews</Text>
        <Text fontFamily="heading" fontSize="4xl" mt={1}>Beauty rituals,{'\n'}booked in seconds.</Text>
        <Button bg="plum.500" borderRadius="full" mt={4} onPress={() => go('book')}>Book appointment</Button>
        <Text fontFamily="heading" fontSize="2xl" mt={6} mb={2}>Popular right now</Text>
        {(services as any[]).filter((s) => s.popular).map((s) => (
          <Pressable key={s.id} onPress={() => { b.toggleService(s.id); go('book'); }}>
            <Box bg="white" borderRadius={22} mb={3} overflow="hidden" shadow={1}>
              <Image source={{ uri: s.image }} style={{ height: 150, width: '100%' }} />
              <Box p={3}><Text bold>{s.name}</Text><Text fontSize="xs" color="coolGray.500">{s.durationMin} min · ₹{s.price}</Text></Box>
            </Box>
          </Pressable>
        ))}
        <Text fontFamily="heading" fontSize="2xl" mt={4} mb={2}>Top artists</Text>
        <HStack space={3}>
          {(staff as any[]).slice(0, 4).map((p) => (
            <VStack key={p.id} alignItems="center" bg="white" p={3} borderRadius={16} w={110}>
              <Avatar source={{ uri: p.avatar }} size="lg" />
              <Text bold fontSize="xs" mt={1}>{p.name.split(' ')[0]}</Text>
              <Text fontSize="xs">★ {p.rating}</Text>
            </VStack>
          ))}
        </HStack>
      </Box>
    </ScrollView>
  );
}

function Booking() {
  const [step, setStep] = useState(1);
  const toast = useToast();
  const qcl = useQueryClient();
  const b = useBooking();
  const { data: services = [] } = useQuery({ queryKey: ['services'], queryFn: mockApi.getServices });
  const { data: staff = [] } = useQuery({ queryKey: ['staff'], queryFn: mockApi.getStaff });
  const { data: slots = [] } = useQuery({ queryKey: ['slots', b.date, b.staffId], queryFn: () => mockApi.getSlots(b.date, b.staffId) });
  const create = useMutation({ mutationFn: mockApi.createBooking, onSuccess: () => { qcl.invalidateQueries({ queryKey: ['appts'] }); setStep(4); } });
  const total = (services as any[]).filter((s) => b.serviceIds.includes(s.id)).reduce((t, s) => t + s.price, 0);

  return (
    <ScrollView><Box p={5}>
      <HStack space={1} mb={4}>{[1, 2, 3, 4].map((i) => <Box key={i} flex={1} h={2} borderRadius="full" bg={i <= step ? 'gold.400' : 'coolGray.200'} />)}</HStack>
      <Text fontFamily="heading" fontSize="3xl">Book your visit</Text>
      {step === 1 && (
        <VStack space={2} mt={4}>{(services as any[]).map((s) => (
          <Pressable key={s.id} onPress={() => b.toggleService(s.id)}>
            <HStack bg={b.serviceIds.includes(s.id) ? 'gold.400:alpha.20' : 'white'} p={3} borderRadius={16} alignItems="center">
              <Text flex={1} bold>{s.name} <Text fontWeight="normal">· ₹{s.price}</Text></Text>
              <Badge colorScheme={b.serviceIds.includes(s.id) ? 'amber' : 'coolGray'}>{b.serviceIds.includes(s.id) ? 'Added' : 'Add'}</Badge>
            </HStack>
          </Pressable>))}
          <Button bg="plum.500" mt={2} isDisabled={!b.serviceIds.length} onPress={() => setStep(2)}>Continue · ₹{total}</Button>
        </VStack>)}
      {step === 2 && (
        <VStack space={3} mt={4}>
          <Text bold>Artist</Text>
          <HStack space={2} flexWrap="wrap">
            <Button size="sm" variant={b.staffId ? 'outline' : 'solid'} onPress={() => b.set({ staffId: undefined })}>Anyone</Button>
            {(staff as any[]).map((p) => <Button key={p.id} size="sm" variant={b.staffId === p.id ? 'solid' : 'outline'} onPress={() => b.set({ staffId: p.id })}>{p.name.split(' ')[0]}</Button>)}
          </HStack>
          <Text bold>Time · {b.date}</Text>
          <HStack flexWrap="wrap" space={2}>
            {(slots as any[]).map((s) => (
              <Button key={s.time} size="sm" mb={2} colorScheme={b.time === s.time ? 'amber' : 'coolGray'} isDisabled={!s.available} onPress={() => b.set({ time: s.time })}>{s.time}</Button>))}
          </HStack>
          <HStack space={2}><Button variant="outline" flex={1} onPress={() => setStep(1)}>Back</Button><Button bg="plum.500" flex={2} isDisabled={!b.time} onPress={() => setStep(3)}>Continue</Button></HStack>
        </VStack>)}
      {step === 3 && (
        <VStack space={3} mt={4} bg="white" p={4} borderRadius={22}>
          <Text>Total</Text><Text fontFamily="heading" fontSize="4xl">₹{total}</Text>
          <Text fontSize="sm" color="coolGray.500">{b.serviceIds.length} service(s) · {b.date} at {b.time}</Text>
          <Button bg="gold.400" onPress={() => create.mutate({ serviceIds: b.serviceIds, date: b.date, time: b.time, total })} isLoading={create.isPending}>Confirm booking</Button>
          <Button variant="ghost" onPress={() => setStep(2)}>Back</Button>
        </VStack>)}
      {step === 4 && (
        <VStack mt={6} alignItems="center" bg="white" p={8} borderRadius={22}>
          <Text fontSize="5xl">✨</Text><Text fontFamily="heading" fontSize="3xl" mt={2}>You’re booked!</Text>
          <Text textAlign="center" color="coolGray.500">{b.date} at {b.time} · confirmation sent</Text>
          <Button mt={4} onPress={() => { setStep(1); b.setTab('visits'); }}>View my visits</Button>
        </VStack>)}
    </Box></ScrollView>
  );
}

function Visits() {
  const { data = [] } = useQuery({ queryKey: ['appts'], queryFn: mockApi.getAppointments });
  return <ScrollView><VStack p={5} space={3}><Text fontFamily="heading" fontSize="3xl">My visits</Text>
    {(data as any[]).map((a) => <Box key={a.id} bg="white" p={4} borderRadius={16}><Text bold>{a.serviceName}</Text><Text fontSize="xs" color="coolGray.500">{a.staffName} · {new Date(a.startAt).toLocaleString()} · ₹{a.price}</Text><Badge mt={2} alignSelf="flex-start">{a.status}</Badge></Box>)}
  </VStack></ScrollView>;
}

function Admin() {
  const { data: s } = useQuery({ queryKey: ['stats'], queryFn: mockApi.getStats });
  const { data: appts = [] } = useQuery({ queryKey: ['appts'], queryFn: mockApi.getAppointments });
  if (!s) return <Box p={5}><Text>Loading analytics…</Text></Box>;
  return (
    <ScrollView><VStack p={5} space={4}>
      <Text fontFamily="heading" fontSize="3xl">Salon overview</Text>
      <HStack space={2}>
        <Box bg="white" p={3} borderRadius={16} flex={1}><Text fontSize="xs">Revenue today</Text><Text bold fontSize="lg">₹{(s as any).revenueToday.toLocaleString()}</Text></Box>
        <Box bg="white" p={3} borderRadius={16} flex={1}><Text fontSize="xs">Bookings</Text><Text bold fontSize="lg">{(s as any).bookingsToday}</Text></Box>
        <Box bg="white" p={3} borderRadius={16} flex={1}><Text fontSize="xs">Occupancy</Text><Text bold fontSize="lg">{(s as any).occupancyPct}%</Text></Box>
      </HStack>
      <Box bg="white" p={3} borderRadius={22}><Text bold mb={1}>Revenue · 30 days</Text>
        <VictoryLine data={(s as any).series30d.map((p: any, i: number) => ({ x: i, y: p.revenue }))} style={{ data: { stroke: GOLD, strokeWidth: 3 } }} height={200} />
      </Box>
      <Box bg="white" p={3} borderRadius={22}><Text bold mb={1}>Bookings by category</Text>
        <VictoryPie data={(s as any).byCategory.map((c: any) => ({ x: c.name, y: c.value }))} colorScale={[GOLD, PLUM, '#7D8C7A', '#B76E79', '#8E7CC3', '#6FA8A0']} height={220} />
      </Box>
      <Box bg="white" p={3} borderRadius={22}><Text bold mb={1}>Staff bookings</Text>
        <VictoryBar data={(s as any).byStaff.map((x: any) => ({ x: x.name, y: x.bookings }))} style={{ data: { fill: PLUM } }} height={200} />
      </Box>
      <Text bold>Today’s appointments</Text>
      {(appts as any[]).slice(0, 6).map((a) => <Box key={a.id} bg="white" p={3} borderRadius={12}><Text bold fontSize="sm">{a.customerName} · {a.serviceName}</Text><Text fontSize="xs">{a.status}</Text></Box>)}
    </VStack></ScrollView>
  );
}

function Shell() {
  const { tab, setTab } = useBooking();
  const { role, switchRole } = useAuth();
  const [adminGate, setAdminGate] = useState(false);
  useEffect(() => { if (tab === 'admin' && role !== 'owner') setAdminGate(true); }, [tab, role]);
  return (
    <VStack flex={1} bg="cream.50" safeArea>
      <HStack p={4} alignItems="center">
        <Text fontFamily="heading" fontSize="2xl" flex={1}>Glam Connect <Text color="gold.500">✦</Text></Text>
        <Button size="sm" variant="outline" onPress={() => switchRole(role === 'owner' ? 'customer' : 'owner')}>{role === 'owner' ? 'Owner ✓' : 'Customer'}</Button>
      </HStack>
      <Box flex={1}>
        {tab === 'home' && <Home go={setTab} />}
        {tab === 'book' && <Booking />}
        {tab === 'visits' && <Visits />}
        {tab === 'admin' && (role === 'owner' ? <Admin /> : <Box p={8}><Text fontFamily="heading" fontSize="2xl">Admin is for owners</Text><Text color="coolGray.500" mt={1}>Switch to Owner (top-right) to see revenue charts, staff performance and today’s book.</Text><Button mt={4} onPress={() => { switchRole('owner'); setAdminGate(false); }}>Switch to owner demo</Button></Box>)}
      </Box>
      <Divider />
      <HStack p={3} justifyContent="space-around" bg="white">
        {[['home', 'Home'], ['book', 'Book'], ['visits', 'Visits'], ['admin', 'Admin']].map(([k, l]) => (
          <Button key={k} size="sm" variant={tab === k ? 'solid' : 'ghost'} colorScheme={tab === k ? 'amber' : 'coolGray'} onPress={() => setTab(k)}>{l}</Button>))}
      </HStack>
    </VStack>
  );
}

export default function App() {
  return <NativeBaseProvider theme={theme}><QueryClientProvider client={qc}><Shell /></QueryClientProvider></NativeBaseProvider>;
}
