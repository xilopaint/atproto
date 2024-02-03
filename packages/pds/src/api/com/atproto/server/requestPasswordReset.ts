import { DAY, HOUR } from '@atproto/common'
import AppContext from '../../../../context'
import { Server } from '../../../../lexicon'

export default function (server: Server, ctx: AppContext) {
  server.com.atproto.server.requestPasswordReset({
    rateLimit: [
      {
        durationMs: DAY,
        points: 50,
      },
      {
        durationMs: HOUR,
        points: 15,
      },
    ],
    handler: async ({ input }) => {
      const email = input.body.email.toLowerCase()

      const user = await ctx.services.account(ctx.db).getAccountByEmail(email)

      if (user) {
        const token = await ctx.services
          .account(ctx.db)
          .createEmailToken(user.did, 'reset_password')
        await ctx.mailer.sendResetPassword(
          { handle: user.handle, token },
          { to: user.email },
        )
      }
    },
  })
}
