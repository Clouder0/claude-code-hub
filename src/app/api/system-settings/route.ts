import { NextResponse } from "next/server";
import { getSession, hasAdminAuthority } from "@/lib/auth";
import { getSystemSettings } from "@/repository/system-config";
import type { SystemSettings } from "@/types/system-config";

type DisplaySystemSettings = Pick<
  SystemSettings,
  "siteTitle" | "currencyDisplay" | "billingModelSource"
>;

function toDisplaySystemSettings(settings: SystemSettings): DisplaySystemSettings {
  return {
    siteTitle: settings.siteTitle,
    currencyDisplay: settings.currencyDisplay,
    billingModelSource: settings.billingModelSource,
  };
}

// 需要数据库连接
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/system-settings
 * 获取系统设置（包括货币显示配置）
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "未授权，请先登录" }, { status: 401 });
    }

    const settings = await getSystemSettings();
    const body = hasAdminAuthority(session) ? settings : toDisplaySystemSettings(settings);
    return NextResponse.json(body, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Failed to fetch system settings:", error);
    return NextResponse.json({ error: "获取系统设置失败" }, { status: 500 });
  }
}
