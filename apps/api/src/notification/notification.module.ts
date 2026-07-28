/**
 * Bildirim modulu.
 *
 * `NotificationService` DISA ACILIR: siparis, tahsilat ve kimlik modulleri
 * kuyruga yazmak icin onu kullanir. Gonderim tarafi (`NotificationDispatch`)
 * yalnizca bakim gorevlerinden cagrilir - bir istek isleyicinin saglayiciya
 * HTTP cagrisi yapmasi, kullaniciyi posta sunucusunun hizina baglar.
 */

import { Module } from '@nestjs/common';

import { DueReminderService } from './due-reminder.service';
import { NotificationController } from './notification.controller';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationService } from './notification.service';
import { MailTransport, PushTransport } from './notification-transport';

@Module({
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationDispatchService,
    DueReminderService,
    MailTransport,
    PushTransport,
  ],
  exports: [NotificationService, NotificationDispatchService, DueReminderService],
})
export class NotificationModule {}
