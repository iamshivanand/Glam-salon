import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { registerPushToken } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export type PushRegistration = 'granted' | 'denied' | 'unsupported' | 'error';

/**
 * Ask for notification permission and register the Expo push token with the
 * API. Reminders can only reach this device after this succeeds.
 */
export async function registerForPush(): Promise<PushRegistration> {
  if (!Device.isDevice) return 'unsupported';

  try {
    let status = (await Notifications.getPermissionsAsync()).status;
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return 'denied';

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const projectId =
      (Constants.expoConfig?.extra as any)?.eas?.projectId ??
      (Constants as any).easConfig?.projectId;

    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown';
    await registerPushToken(token.data, platform);
    return 'granted';
  } catch {
    return 'error';
  }
}

/** Deep-link reminder taps to the visits screen. Returns an unsubscribe fn. */
export function subscribeToNotificationTaps(onTap: () => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener(() => onTap());
  return () => subscription.remove();
}
