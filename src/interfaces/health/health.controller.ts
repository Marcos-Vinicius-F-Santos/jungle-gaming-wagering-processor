import { Controller, Get, Res } from '@nestjs/common';

import { HealthService } from './application/health.service';

interface HealthResponse {
  statusCode: number;
}

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: HealthResponse) {
    const report = await this.healthService.readiness();
    response.statusCode = report.ready ? 200 : 503;
    return report;
  }
}
