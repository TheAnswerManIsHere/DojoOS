# Post-merge verification — DojoOS

Every product-visible PR in production phase carries a **Post-merge
verification** section in its body: the checks that prove the merged
change works in the development workspace, run by Claude through the
Replit connector at close-out. A prototype-phase PR carries none; its
feedback rail is its verification.

**The checks are read-only.** They may run builds, typechecks, lints,
read-only queries and requests against the running app. They may not
re-run destructive suites, write to the production database, publish, or
change live state. A step that needs a write says so and names how it is
reverted in the same run. A PR whose verification needs nothing says
"None needed" and why.

Each check names the command or action and the output that counts as a
pass. The results are quoted in the merge report.
